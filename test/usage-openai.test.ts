// Unit tests: OpenAI token usage extraction.
// Verifies the EXACT attribution rules for prompt/completion/cached tokens,
// reasoning tokens, TTFT, TPS, and the critical include_usage streaming behavior.

import { describe, expect, test } from "bun:test";
import {
  extractOpenAiNonStreaming,
  extractOpenAiStreaming,
  type OpenAIStreamChunk,
} from "./helpers/usage-extractors";

describe("OpenAI non-streaming usage extraction", () => {
  test("basic usage with prompt + completion + total", () => {
    const body = {
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "gpt-4o",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Hello!" },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: 29,
        completion_tokens: 11,
        total_tokens: 40,
      },
    };
    const m = extractOpenAiNonStreaming(body, 800);
    expect(m.provider).toBe("openai");
    expect(m.streaming).toBe(false);
    expect(m.input_tokens).toBe(29);
    expect(m.output_tokens).toBe(11);
    expect(m.total_input_tokens).toBe(29);
    expect(m.total_output_tokens).toBe(11);
    expect(m.cache_creation_tokens).toBeNull(); // OpenAI has no cache creation concept
    expect(m.cache_read_tokens).toBe(0); // default when prompt_tokens_details absent
    expect(m.thinking_tokens).toBeNull();
    expect(m.ttft_ms).toBeNull();
    expect(m.duration_ms).toBe(800);
    expect(m.usage_missing).toBe(false);
  });

  test("cached_tokens from prompt_tokens_details", () => {
    const body = {
      usage: {
        prompt_tokens: 2006,
        completion_tokens: 300,
        total_tokens: 2306,
        prompt_tokens_details: { cached_tokens: 1920, audio_tokens: 0 },
      },
    };
    const m = extractOpenAiNonStreaming(body, 1000);
    expect(m.cache_read_tokens).toBe(1920);
    expect(m.input_tokens).toBe(2006); // total prompt, NOT just uncached
  });

  test("reasoning_tokens from completion_tokens_details (reasoning models)", () => {
    const body = {
      usage: {
        prompt_tokens: 100,
        completion_tokens: 200,
        total_tokens: 300,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: {
          reasoning_tokens: 150,
          accepted_prediction_tokens: 0,
          rejected_prediction_tokens: 0,
          audio_tokens: 0,
        },
      },
    };
    const m = extractOpenAiNonStreaming(body, 2000);
    expect(m.thinking_tokens).toBe(150);
    expect(m.output_tokens).toBe(200); // total (reasoning is inclusive)
  });

  test("usage absent → usage_missing = true", () => {
    const body = { id: "x", choices: [] };
    const m = extractOpenAiNonStreaming(body, 500);
    expect(m.usage_missing).toBe(true);
    expect(m.input_tokens).toBeNull();
    expect(m.output_tokens).toBeNull();
  });

  test("TPS computed from duration", () => {
    const body = {
      usage: { prompt_tokens: 10, completion_tokens: 100, total_tokens: 110 },
    };
    const m = extractOpenAiNonStreaming(body, 1000);
    // Non-streaming: TPS = completion / duration = 100 / 1s = 100 tps
    expect(m.tps).toBeCloseTo(100, 1);
  });

  test("compatible provider omits prompt_tokens_details → cached = 0", () => {
    // vLLM / llama.cpp may omit nested objects entirely
    const body = {
      usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    };
    const m = extractOpenAiNonStreaming(body, 500);
    expect(m.cache_read_tokens).toBe(0);
    expect(m.thinking_tokens).toBeNull();
  });
});

describe("OpenAI streaming usage extraction", () => {
  // Helper: build a realistic streaming chunk sequence with timestamps.
  function buildChunks(opts: {
    includeUsage: boolean;
    contentChunks?: number;
    ttftMs?: number;
    perChunkMs?: number;
    promptTokens?: number;
    completionTokens?: number;
    cachedTokens?: number;
    reasoningTokens?: number;
  }): { chunks: OpenAIStreamChunk[]; startedAt: number } {
    const o = {
      contentChunks: 5,
      ttftMs: 100,
      perChunkMs: 50,
      promptTokens: 100,
      completionTokens: 50,
      cachedTokens: 0,
      reasoningTokens: 0,
      ...opts,
    };
    const startedAt = 1000;
    let t = startedAt;
    const chunks: OpenAIStreamChunk[] = [];

    // Content chunks (usage: null)
    t += o.ttftMs;
    for (let i = 0; i < o.contentChunks; i++) {
      chunks.push({
        choices: [{ delta: { content: `chunk${i}` }, finish_reason: null }],
        usage: null,
        received_at: t,
      });
      t += o.perChunkMs;
    }

    // Finish chunk (usage: null)
    chunks.push({
      choices: [{ delta: {}, finish_reason: "stop" }],
      usage: null,
      received_at: t,
    });

    // Final usage chunk (ONLY if include_usage)
    if (o.includeUsage) {
      const usage: Record<string, unknown> = {
        prompt_tokens: o.promptTokens,
        completion_tokens: o.completionTokens,
        total_tokens: o.promptTokens + o.completionTokens,
        prompt_tokens_details: { cached_tokens: o.cachedTokens, audio_tokens: 0 },
      };
      if (o.reasoningTokens > 0) {
        usage.completion_tokens_details = {
          reasoning_tokens: o.reasoningTokens,
          accepted_prediction_tokens: 0,
          rejected_prediction_tokens: 0,
          audio_tokens: 0,
        };
      }
      chunks.push({
        choices: [], // EMPTY array — per spec
        usage,
        received_at: t + 5,
      });
    }

    return { chunks, startedAt };
  }

  test("with include_usage: final chunk has choices=[] and full usage", () => {
    const { chunks, startedAt } = buildChunks({
      includeUsage: true,
      promptTokens: 100,
      completionTokens: 50,
      cachedTokens: 80,
    });
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.provider).toBe("openai");
    expect(m.streaming).toBe(true);
    expect(m.input_tokens).toBe(100);
    expect(m.output_tokens).toBe(50);
    expect(m.cache_read_tokens).toBe(80);
    expect(m.total_input_tokens).toBe(100);
    expect(m.usage_missing).toBe(false);
  });

  test("WITHOUT include_usage: usage_missing = true (every chunk has usage: null)", () => {
    const { chunks, startedAt } = buildChunks({ includeUsage: false });
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.usage_missing).toBe(true);
    expect(m.input_tokens).toBeNull();
    expect(m.output_tokens).toBeNull();
  });

  test("TTFT derived from first chunk with non-empty delta.content", () => {
    const { chunks, startedAt } = buildChunks({
      includeUsage: true,
      ttftMs: 150,
      perChunkMs: 50,
    });
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.ttft_ms).not.toBeNull();
    // startedAt=1000, first content chunk at 1000+150=1150 → TTFT = 150
    expect(m.ttft_ms).toBe(150);
  });

  test("TTFT null if no content deltas (empty completion)", () => {
    const startedAt = 1000;
    const chunks: OpenAIStreamChunk[] = [
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: null, received_at: 1050 },
      {
        choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
        received_at: 1060,
      },
    ];
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.ttft_ms).toBeNull();
    expect(m.output_tokens).toBe(0);
  });

  test("reasoning_tokens captured from final usage chunk", () => {
    const { chunks, startedAt } = buildChunks({
      includeUsage: true,
      reasoningTokens: 150,
      completionTokens: 200,
    });
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.thinking_tokens).toBe(150);
    expect(m.output_tokens).toBe(200);
  });

  test("TPS computed from (duration - TTFT)", () => {
    const { chunks, startedAt } = buildChunks({
      includeUsage: true,
      completionTokens: 100,
      ttftMs: 100,
      perChunkMs: 100,
      contentChunks: 10,
    });
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.output_tokens).toBe(100);
    expect(m.ttft_ms).toBe(100);
    expect(m.duration_ms).not.toBeNull();
    const genMs = (m.duration_ms ?? 0) - (m.ttft_ms ?? 0);
    const expectedTps = (100 / genMs) * 1000;
    expect(m.tps).toBeCloseTo(expectedTps, 1);
    expect(m.tps).toBeGreaterThan(0);
  });

  test("TPS null when generation time < 1 second", () => {
    const { chunks, startedAt } = buildChunks({
      includeUsage: true,
      completionTokens: 100,
      ttftMs: 100,
      perChunkMs: 10,
      contentChunks: 10,
    });
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.output_tokens).toBe(100);
    expect(m.tps).toBeNull();
  });

  test("stream aborted before usage chunk → usage_missing = true but TTFT preserved", () => {
    // Simulate client abort: content chunks arrive but no final usage chunk
    const startedAt = 1000;
    const chunks: OpenAIStreamChunk[] = [
      {
        choices: [{ delta: { content: "partial" }, finish_reason: null }],
        usage: null,
        received_at: 1100,
      },
      {
        choices: [{ delta: { content: "response" }, finish_reason: null }],
        usage: null,
        received_at: 1150,
      },
      // NO finish chunk, NO usage chunk — stream cut
    ];
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.usage_missing).toBe(true);
    expect(m.ttft_ms).toBe(100); // 1100 - 1000
    expect(m.output_tokens).toBeNull();
    expect(m.tps).toBeNull(); // can't compute without output_tokens
  });

  test("final usage chunk identified by choices=[] (not absent choices)", () => {
    // Edge: a chunk with choices.length === 0 AND usage !== null is the usage chunk
    const startedAt = 1000;
    const chunks: OpenAIStreamChunk[] = [
      {
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
        usage: null,
        received_at: 1100,
      },
      {
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
        received_at: 1200,
      },
    ];
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.input_tokens).toBe(5);
    expect(m.output_tokens).toBe(2);
    expect(m.usage_missing).toBe(false);
  });

  test("compatible provider omits prompt_tokens_details in streaming → cached = 0", () => {
    const startedAt = 1000;
    const chunks: OpenAIStreamChunk[] = [
      {
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
        usage: null,
        received_at: 1100,
      },
      {
        choices: [],
        usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 }, // no details
        received_at: 1200,
      },
    ];
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.cache_read_tokens).toBe(0);
    expect(m.thinking_tokens).toBeNull();
  });

  test("usage chunk with non-empty choices + non-null usage (umans-coder / compatible provider)", () => {
    // Some compatible providers send the final usage chunk with a non-empty
    // choices array containing an empty delta, instead of choices: [].
    const startedAt = 1000;
    const chunks: OpenAIStreamChunk[] = [
      {
        choices: [{ delta: { content: "hi" }, finish_reason: null }],
        usage: null,
        received_at: 1100,
      },
      {
        choices: [{ delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 },
        received_at: 1200,
      },
    ];
    const m = extractOpenAiStreaming(chunks, startedAt);
    expect(m.usage_missing).toBe(false);
    expect(m.input_tokens).toBe(12);
    expect(m.output_tokens).toBe(8);
    expect(m.total_input_tokens).toBe(12);
    expect(m.total_output_tokens).toBe(8);
  });
});
