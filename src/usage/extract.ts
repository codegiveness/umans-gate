// Extractors for LLM token usage metrics from Anthropic and OpenAI responses.
//
// Attribution rules are derived from official API docs:
//   Anthropic: https://platform.claude.com/docs/en/build-with-claude/streaming
//   OpenAI:     https://developers.openai.com/api/docs/api-reference/chat

import { computeTps, emptyMetrics, num, numOr } from "./helpers.js";
import { parseAnthropicSse, parseOpenAiSse } from "./sse-parse.js";
import type {
  AnthropicSseEvent,
  AnthropicUsage,
  OpenAIStreamChunk,
  OpenAIUsage,
  TimedChunk,
  UsageMetrics,
} from "./types.js";

type ResponseLike = {
  responseBody: string;
  chunkTimes: number[];
  chunks?: TimedChunk[];
  durationMs: number;
  requestStartedAt: number;
};

type UsageExtractResult = UsageMetrics;

type Extractor = (res: ResponseLike) => UsageExtractResult;

type ProviderExtractors = { stream: Extractor; batch: Extractor };

const EXTRACTORS: Record<string, ProviderExtractors> = {
  anthropic: {
    stream: (res) =>
      extractAnthropicStreaming(
        parseAnthropicSse(res.responseBody, res.chunkTimes, res.chunks),
        res.requestStartedAt,
      ),
    batch: (res) => extractAnthropicNonStreaming(JSON.parse(res.responseBody), res.durationMs),
  },
  openai: {
    stream: (res) =>
      extractOpenAiStreaming(
        parseOpenAiSse(res.responseBody, res.chunkTimes, res.chunks),
        res.requestStartedAt,
      ),
    batch: (res) => extractOpenAiNonStreaming(JSON.parse(res.responseBody), res.durationMs),
  },
};

/**
 * Extract Anthropic usage from a NON-STREAMING response body.
 *
 * Rules (per https://platform.claude.com/docs/en/build-with-claude/working-with-messages):
 *  - usage lives at top-level `usage`
 *  - cache_creation_input_tokens / cache_read_input_tokens are null when no caching, 0 when caching enabled but nothing cached
 *  - total input = input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 */
export function extractAnthropicNonStreaming(
  body: unknown,
  durationMs: number | null,
): UsageMetrics {
  const b = body as { usage?: AnthropicUsage };
  const u = b?.usage;
  if (!u) {
    return emptyMetrics("anthropic", false, durationMs);
  }
  const input = num(u.input_tokens);
  const output = num(u.output_tokens);
  const cacheCreate = numOr(u.cache_creation_input_tokens, 0);
  const cacheRead = numOr(u.cache_read_input_tokens, 0);
  const totalInput = input + cacheCreate + cacheRead;
  const thinking = u.output_tokens_details?.thinking_tokens ?? null;
  return {
    provider: "anthropic",
    streaming: false,
    input_tokens: input,
    output_tokens: output,
    cache_creation_tokens: cacheCreate,
    cache_read_tokens: cacheRead,
    total_input_tokens: totalInput,
    total_output_tokens: output,
    thinking_tokens: thinking,
    ttft_ms: null, // TTFT not derivable from non-streaming response
    duration_ms: durationMs,
    tps: computeTps(output, durationMs, null),
    usage_missing: false,
  };
}

/**
 * Extract Anthropic usage from a STREAMING response (array of SSE events).
 *
 * Rules (per https://platform.claude.com/docs/en/build-with-claude/streaming):
 *  - message_start.message.usage seeds input_tokens + cache_* (null → 0)
 *  - message_delta.usage.output_tokens is CUMULATIVE — always overwrite
 *  - message_delta.usage.cache_* / input_tokens only overwrite if != null
 *  - ping events carry no usage
 *  - TTFT = delta from request start to first content_block_delta event (any delta type)
 */
export function extractAnthropicStreaming(
  events: AnthropicSseEvent[],
  requestStartedAt: number,
): UsageMetrics {
  let input: number | null = null;
  let output: number | null = null;
  let cacheCreate = 0;
  let cacheRead = 0;
  let thinking: number | null = null;
  let ttftMs: number | null = null;
  let lastEventAt: number | null = null;
  let sawUsage = false;

  for (const ev of events) {
    if (ev.received_at) lastEventAt = ev.received_at;

    if (ev.type === "message_start") {
      const u = ev.message?.usage;
      if (u) {
        input = num(u.input_tokens);
        cacheCreate = numOr(u.cache_creation_input_tokens, 0);
        cacheRead = numOr(u.cache_read_input_tokens, 0);
        // output_tokens here is ~1 (placeholder) — do NOT use as final
        sawUsage = true;
      }
    } else if (ev.type === "message_delta") {
      const u = ev.usage;
      if (u) {
        // output_tokens is cumulative — ALWAYS overwrite
        if (u.output_tokens != null) {
          output = num(u.output_tokens);
          sawUsage = true;
        }
        // cache / input fields only overwrite if present and non-null
        if (u.input_tokens != null) input = num(u.input_tokens);
        if (u.cache_creation_input_tokens != null) cacheCreate = num(u.cache_creation_input_tokens);
        if (u.cache_read_input_tokens != null) cacheRead = num(u.cache_read_input_tokens);
        if (u.output_tokens_details?.thinking_tokens != null) {
          thinking = u.output_tokens_details.thinking_tokens;
        }
      }
    } else if (ev.type === "content_block_delta" && ttftMs === null && ev.received_at) {
      ttftMs = ev.received_at - requestStartedAt;
    }
  }

  const durationMs = lastEventAt ? lastEventAt - requestStartedAt : null;
  const totalInput = input != null ? input + cacheCreate + cacheRead : null;

  return {
    provider: "anthropic",
    streaming: true,
    input_tokens: input,
    output_tokens: output,
    cache_creation_tokens: cacheCreate,
    cache_read_tokens: cacheRead,
    total_input_tokens: totalInput,
    total_output_tokens: output,
    thinking_tokens: thinking,
    ttft_ms: ttftMs,
    duration_ms: durationMs,
    tps: computeTps(output, durationMs, ttftMs),
    usage_missing: !sawUsage,
  };
}

/**
 * Extract OpenAI usage from a NON-STREAMING response body.
 *
 * Rules (per https://developers.openai.com/api/docs/api-reference/chat):
 *  - usage always present with prompt_tokens, completion_tokens, total_tokens
 *  - prompt_tokens_details.cached_tokens defaults to 0 but may be omitted by compatible providers
 *  - completion_tokens_details.reasoning_tokens present for reasoning models
 */
export function extractOpenAiNonStreaming(body: unknown, durationMs: number | null): UsageMetrics {
  const b = body as { usage?: OpenAIUsage };
  const u = b?.usage;
  if (!u) {
    return emptyMetrics("openai", false, durationMs);
  }
  const prompt = num(u.prompt_tokens);
  const completion = num(u.completion_tokens);
  const cached = numOr(u.prompt_tokens_details?.cached_tokens, 0);
  const reasoning = u.completion_tokens_details?.reasoning_tokens ?? null;
  return {
    provider: "openai",
    streaming: false,
    input_tokens: prompt,
    output_tokens: completion,
    cache_creation_tokens: null, // OpenAI has no "cache creation" concept
    cache_read_tokens: cached,
    total_input_tokens: prompt,
    total_output_tokens: completion,
    thinking_tokens: reasoning,
    ttft_ms: null,
    duration_ms: durationMs,
    tps: computeTps(completion, durationMs, null),
    usage_missing: false,
  };
}

/**
 * Extract OpenAI usage from a STREAMING response (array of chunks).
 *
 * Rules (per https://developers.openai.com/api/docs/api-reference/chat):
 *  - Without stream_options.include_usage, every chunk has usage: null → no usage
 *  - With include_usage, the FINAL chunk before [DONE] carries the full usage object
 *    (per spec choices: [], but compatible providers may include a non-empty choices array)
 *  - TTFT = delta from request start to first chunk with a non-empty delta
 *    (content, reasoning_content, or tool_calls — whichever arrives first)
 *  - If stream is aborted, the usage chunk may never arrive
 */
export function extractOpenAiStreaming(
  chunks: OpenAIStreamChunk[],
  requestStartedAt: number,
): UsageMetrics {
  let usage: OpenAIUsage | null = null;
  let ttftMs: number | null = null;
  let lastChunkAt: number | null = null;

  for (const ch of chunks) {
    if (ch.received_at) lastChunkAt = ch.received_at;
    // TTFT = time to first non-empty delta of any kind: content, reasoning, or tool calls.
    // Reasoning models emit reasoning_content first; tool-calling responses may only have tool_calls.
    if (ttftMs === null && ch.received_at && Array.isArray(ch.choices) && ch.choices.length > 0) {
      const d = ch.choices[0]?.delta;
      if (d && (d.content || d.reasoning_content || d.tool_calls)) {
        ttftMs = ch.received_at - requestStartedAt;
      }
    }
    // Usage chunk: usage is non-null. Per OpenAI spec this is the final chunk
    // with choices: [], but compatible providers (e.g. umans-coder) send it
    // with a non-empty choices array containing an empty delta — so we key
    // solely on the presence of the usage object.
    if (ch.usage != null) {
      usage = ch.usage;
    }
  }

  const durationMs = lastChunkAt ? lastChunkAt - requestStartedAt : null;

  if (!usage) {
    const m = emptyMetrics("openai", true, durationMs);
    m.ttft_ms = ttftMs;
    m.tps = computeTps(null, durationMs, ttftMs);
    m.usage_missing = true;
    return m;
  }

  const prompt = num(usage.prompt_tokens);
  const completion = num(usage.completion_tokens);
  const cached = numOr(usage.prompt_tokens_details?.cached_tokens, 0);
  const reasoning = usage.completion_tokens_details?.reasoning_tokens ?? null;

  return {
    provider: "openai",
    streaming: true,
    input_tokens: prompt,
    output_tokens: completion,
    cache_creation_tokens: null,
    cache_read_tokens: cached,
    total_input_tokens: prompt,
    total_output_tokens: completion,
    thinking_tokens: reasoning,
    ttft_ms: ttftMs,
    duration_ms: durationMs,
    tps: computeTps(completion, durationMs, ttftMs),
    usage_missing: false,
  };
}

/** Extract model name from a request body (both Anthropic and OpenAI shapes). */
export function extractModel(requestBody: unknown): string {
  const b = requestBody as { model?: string; messages?: unknown };
  if (typeof b?.model === "string" && b.model.length > 0) return b.model;
  return "unknown";
}

/**
 * Unified usage extraction entry point. Dispatches to the correct extractor
 * based on provider + streaming flags, parses the request body for the model
 * name, and stamps the model onto the returned metrics.
 *
 * @param opts.provider       "anthropic" | "openai"
 * @param opts.streaming      whether the response was SSE-streamed
 * @param opts.requestBody    raw request body JSON string
 * @param opts.responseBody   raw response body (SSE string for streaming, JSON for non-streaming)
 * @param opts.durationMs     full request duration in ms (used for non-streaming + fallback)
 * @param opts.requestStartedAt epoch ms when the request started (used for streaming TTFT/duration)
 * @param opts.chunkTimes     array of epoch ms timestamps per SSE chunk (for streaming TTFT)
 * @returns `{ model, metrics }` — model is the extracted model name, metrics has model stamped on it
 */
export function extractUsage(opts: {
  provider: "anthropic" | "openai";
  streaming: boolean;
  requestBody: string;
  responseBody: string;
  durationMs: number;
  requestStartedAt: number;
  chunkTimes: number[];
  chunks?: TimedChunk[];
}): { model: string; metrics: UsageMetrics } {
  const parsedBody = JSON.parse(opts.requestBody);
  const model = extractModel(parsedBody);
  const key = opts.streaming ? "stream" : "batch";
  const extractor = EXTRACTORS[opts.provider]?.[key] ?? EXTRACTORS.openai[key];
  const metrics = extractor({
    responseBody: opts.responseBody,
    chunkTimes: opts.chunkTimes,
    chunks: opts.chunks,
    durationMs: opts.durationMs,
    requestStartedAt: opts.requestStartedAt,
  });
  metrics.model = model;
  return { model, metrics };
}
