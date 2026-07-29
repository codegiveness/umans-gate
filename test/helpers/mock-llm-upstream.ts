// Mock LLM upstream that returns REALISTIC Anthropic + OpenAI responses
// with token usage data, for testing extraction logic.
//
// Supports:
//   - Anthropic /v1/messages (streaming + non-streaming)
//   - OpenAI /v1/chat/completions (streaming + non-streaming, with/without include_usage)
//   - Multi-turn sessions with cache hits (cache_read_input_tokens grows)
//   - Configurable delays for TTFT/TPS measurement

/** Loose shape of request bodies handled by the mock upstream. */
export interface MockRequestBody {
  model?: string;
  stream?: boolean;
  system?: string | { text?: string; type?: string }[];
  messages?: { content?: unknown; role?: string }[];
  tools?: unknown[];
  max_tokens?: number;
  stream_options?: { include_usage?: boolean };
  [key: string]: unknown;
}

/** Usage object shape built by the mock (subset of Anthropic/OpenAI usage). */
export interface MockUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  output_tokens_details?: Record<string, number>;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: Record<string, number>;
  completion_tokens_details?: Record<string, number>;
  [key: string]: unknown;
}

export interface MockUsageConfig {
  /** Base input tokens for the prompt. */
  inputTokens: number;
  /** Base output tokens. */
  outputTokens: number;
  /** Tokens written to cache on first call (Anthropic cache_creation_input_tokens). */
  cacheCreateTokens?: number;
  /** Tokens read from cache (Anthropic cache_read_input_tokens / OpenAI cached_tokens). */
  cacheReadTokens?: number;
  /** Reasoning / thinking tokens. */
  thinkingTokens?: number;
  /** TTFT delay in ms (delay before first content delta). */
  ttftMs?: number;
  /** Per-token delay in ms (for TPS simulation). */
  perTokenMs?: number;
}

export interface MockUpstreamHandle {
  port: number;
  /** Call counter — increments per request. */
  getCallCount(): number;
  /** Get the Nth request body (0-indexed). */
  getRequest(index: number): unknown;
  /** Reset the call counter and request log (for isolating test sessions). */
  reset(): void;
  close(): Promise<void>;
}

/** Pseudo-random jitter in range [base*0.8, base*1.2] for realistic metric variation. */
function jitter(base: number): number {
  const factor = 0.8 + Math.random() * 0.4;
  return Math.round(base * factor);
}

export function startMockLlmUpstream(port = 0): MockUpstreamHandle {
  let callCount = 0;
  const requests: unknown[] = [];
  const seenSystemPrompts = new Set<string>();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};

      // /v1/status is fetched by StatusClient, not an LLM API call.
      if (url.pathname === "/v1/status") {
        return new Response("not found", { status: 404 });
      }

      requests.push(body);
      callCount++;

      // ─── Anthropic /v1/messages ───────────────────────────────────────────
      if (url.pathname === "/v1/messages") {
        return handleAnthropic(body, callCount, seenSystemPrompts);
      }

      // ─── OpenAI /v1/chat/completions ─────────────────────────────────────
      if (url.pathname === "/v1/chat/completions") {
        return handleOpenAi(body, callCount);
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    port: server.port ?? 0,
    getCallCount: () => callCount,
    getRequest: (i: number) => requests[i],
    reset: () => {
      callCount = 0;
      requests.length = 0;
      seenSystemPrompts.clear();
    },
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        callCount = 0;
        requests.length = 0;
        setTimeout(res, 100);
      }),
  };
}

// ─── Anthropic handler ──────────────────────────────────────────────────────

export async function handleAnthropic(
  body: MockRequestBody,
  callCount: number,
  seenSystemPrompts: Set<string>,
): Promise<Response> {
  const streaming = body?.stream === true;
  const cfg = resolveAnthropicUsage(body, seenSystemPrompts);
  const msgId = `msg_${callCount}`;

  if (!streaming) {
    // Match the streaming path's simulated latency so captured duration_ms is realistic.
    await Bun.sleep((cfg.ttftMs ?? 50) + (cfg.perTokenMs ?? 5) * cfg.outputTokens);
    const usage: MockUsage = {
      input_tokens: cfg.inputTokens,
      output_tokens: cfg.outputTokens,
    };
    if (cfg.cacheCreateTokens != null) usage.cache_creation_input_tokens = cfg.cacheCreateTokens;
    if (cfg.cacheReadTokens != null) usage.cache_read_input_tokens = cfg.cacheReadTokens;
    if (cfg.thinkingTokens != null) {
      usage.output_tokens_details = { thinking_tokens: cfg.thinkingTokens };
    }
    return Response.json({
      id: msgId,
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello from mock Anthropic!" }],
      model: body?.model ?? "umans-glm-5.2",
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    });
  }

  // Streaming: message_start → content_block_start → content_block_delta* → content_block_stop → message_delta → message_stop
  const enc = new TextEncoder();
  const ttft = cfg.ttftMs ?? 50;
  const perToken = cfg.perTokenMs ?? 5;
  const outputTokens = cfg.outputTokens;

  const usageStart: MockUsage = {
    input_tokens: cfg.inputTokens,
    output_tokens: 1, // placeholder per spec
  };
  if (cfg.cacheCreateTokens != null) usageStart.cache_creation_input_tokens = cfg.cacheCreateTokens;
  if (cfg.cacheReadTokens != null) usageStart.cache_read_input_tokens = cfg.cacheReadTokens;

  const usageDelta: MockUsage = {
    output_tokens: outputTokens, // cumulative final
  };
  // message_delta may re-carry cache fields as cumulative
  if (cfg.cacheCreateTokens != null) usageDelta.cache_creation_input_tokens = cfg.cacheCreateTokens;
  if (cfg.cacheReadTokens != null) usageDelta.cache_read_input_tokens = cfg.cacheReadTokens;
  if (cfg.thinkingTokens != null) {
    usageDelta.output_tokens_details = { thinking_tokens: cfg.thinkingTokens };
  }

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      // message_start
      controller.enqueue(
        enc.encode(
          `event: message_start\ndata: ${JSON.stringify({
            type: "message_start",
            message: {
              id: msgId,
              type: "message",
              role: "assistant",
              content: [],
              model: body?.model ?? "umans-glm-5.2",
              stop_reason: null,
              stop_sequence: null,
              usage: usageStart,
            },
          })}\n\n`,
        ),
      );

      // content_block_start
      await Bun.sleep(ttft); // simulate TTFT
      controller.enqueue(
        enc.encode(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        ),
      );

      // content_block_delta events (one per output token, simplified to chunks)
      const chunks = Math.min(outputTokens, 10); // emit 10 visible chunks
      const tokensPerChunk = Math.ceil(outputTokens / chunks);
      for (let i = 0; i < chunks; i++) {
        await Bun.sleep(perToken * tokensPerChunk);
        controller.enqueue(
          enc.encode(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: `chunk${i} ` },
            })}\n\n`,
          ),
        );
      }

      // content_block_stop
      controller.enqueue(
        enc.encode(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
        ),
      );

      // message_delta with cumulative usage
      controller.enqueue(
        enc.encode(
          `event: message_delta\ndata: ${JSON.stringify({
            type: "message_delta",
            delta: { stop_reason: "end_turn", stop_sequence: null },
            usage: usageDelta,
          })}\n\n`,
        ),
      );

      // message_stop
      controller.enqueue(
        enc.encode(`event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`),
      );
      controller.close();
    },
  });

  return new Response(readable, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}

/** Resolve usage for an Anthropic request — simulates cache warming via system-prompt tracking. */
function resolveAnthropicUsage(
  body: MockRequestBody,
  seenSystemPrompts: Set<string>,
): Required<MockUsageConfig> {
  const hasCacheControl = JSON.stringify(body).includes("cache_control");
  const systemText =
    typeof body?.system === "string"
      ? body.system
      : Array.isArray(body?.system)
        ? body.system.map((b: { text?: string }) => b?.text ?? "").join("")
        : "";
  const inputTokens = body?.messages ? JSON.stringify(body.messages).length : 100;
  const cacheableTokens = Math.max(100, systemText.length || inputTokens);

  // First time seeing this system prompt → create cache.
  // Subsequent calls with the same system prompt → read from cache.
  const isCold = !seenSystemPrompts.has(systemText);
  const maxTokens = Math.min(typeof body?.max_tokens === "number" ? body.max_tokens : 50, 100);
  if (hasCacheControl) {
    if (isCold) {
      seenSystemPrompts.add(systemText);
      return {
        inputTokens: Math.max(10, inputTokens - cacheableTokens),
        outputTokens: maxTokens,
        cacheCreateTokens: cacheableTokens,
        cacheReadTokens: 0,
        thinkingTokens: 0,
        ttftMs: jitter(50),
        perTokenMs: jitter(5),
      };
    }
    return {
      inputTokens: Math.max(10, inputTokens - cacheableTokens),
      outputTokens: maxTokens,
      cacheCreateTokens: 0,
      cacheReadTokens: cacheableTokens,
      thinkingTokens: 0,
      ttftMs: jitter(30),
      perTokenMs: jitter(4),
    };
  }
  return {
    inputTokens: Math.max(100, inputTokens),
    outputTokens: maxTokens,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    thinkingTokens: 0,
    ttftMs: jitter(50),
    perTokenMs: jitter(5),
  };
}

// ─── OpenAI handler ─────────────────────────────────────────────────────────

export function handleOpenAi(body: MockRequestBody, _callCount: number): Response {
  const streaming = body?.stream === true;
  const includeUsage = body?.stream_options?.include_usage === true;

  const inputTokens = body?.messages ? JSON.stringify(body.messages).length : 100;
  const outputTokens = Math.min(typeof body?.max_tokens === "number" ? body.max_tokens : 50, 100);
  const cachedTokens =
    body?.messages && JSON.stringify(body.messages).includes("cache")
      ? Math.floor(inputTokens * 0.8)
      : 0;
  const reasoning = body?.model?.startsWith("o") ? 10 : 0;

  if (!streaming) {
    const usage: MockUsage = {
      prompt_tokens: inputTokens,
      completion_tokens: outputTokens,
      total_tokens: inputTokens + outputTokens,
      prompt_tokens_details: { cached_tokens: cachedTokens, audio_tokens: 0 },
    };
    if (reasoning > 0) {
      usage.completion_tokens_details = {
        reasoning_tokens: reasoning,
        accepted_prediction_tokens: 0,
        rejected_prediction_tokens: 0,
        audio_tokens: 0,
      };
    }
    return Response.json({
      id: "chatcmpl-mock",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? "umans-flash",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello from mock OpenAI!" },
          finish_reason: "stop",
        },
      ],
      usage,
    });
  }

  // Streaming
  const enc = new TextEncoder();
  const ttft = jitter(50);
  const perToken = jitter(5);

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Content chunks (usage: null)
      await Bun.sleep(ttft);
      const chunks = Math.min(outputTokens, 10);
      for (let i = 0; i < chunks; i++) {
        await Bun.sleep(perToken);
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body?.model ?? "umans-flash",
              choices: [
                {
                  index: 0,
                  delta: { content: `chunk${i} ` },
                  finish_reason: null,
                },
              ],
              usage: null,
            })}\n\n`,
          ),
        );
      }

      // Finish chunk (usage: null)
      controller.enqueue(
        enc.encode(
          `data: ${JSON.stringify({
            id: "chatcmpl-mock",
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model: body?.model ?? "umans-flash",
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: "stop",
              },
            ],
            usage: null,
          })}\n\n`,
        ),
      );

      // Final usage chunk (ONLY if include_usage)
      if (includeUsage) {
        const usage: MockUsage = {
          prompt_tokens: inputTokens,
          completion_tokens: outputTokens,
          total_tokens: inputTokens + outputTokens,
          prompt_tokens_details: { cached_tokens: cachedTokens, audio_tokens: 0 },
        };
        if (reasoning > 0) {
          usage.completion_tokens_details = {
            reasoning_tokens: reasoning,
            accepted_prediction_tokens: 0,
            rejected_prediction_tokens: 0,
            audio_tokens: 0,
          };
        }
        controller.enqueue(
          enc.encode(
            `data: ${JSON.stringify({
              id: "chatcmpl-mock",
              object: "chat.completion.chunk",
              created: Math.floor(Date.now() / 1000),
              model: body?.model ?? "umans-flash",
              choices: [], // EMPTY array — spec
              usage,
            })}\n\n`,
          ),
        );
      }

      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });

  return new Response(readable, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  });
}
