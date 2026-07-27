// Unit tests: Anthropic token usage extraction.
// Verifies the EXACT attribution rules for input/output/cached tokens,
// TTFT derivation, TPS computation, and null handling — for both
// streaming and non-streaming responses.
//
// Source of truth for field semantics:
//   https://platform.claude.com/docs/en/build-with-claude/streaming
//   https://platform.claude.com/docs/en/build-with-claude/prompt-caching

import { describe, expect, test } from "bun:test";
import {
  type AnthropicSseEvent,
  extractAnthropicNonStreaming,
  extractAnthropicStreaming,
} from "./helpers/usage-extractors";

describe("Anthropic non-streaming usage extraction", () => {
  test("basic usage with input + output only", () => {
    const body = {
      id: "msg_1",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "Hello!" }],
      usage: {
        input_tokens: 12,
        output_tokens: 6,
      },
    };
    const m = extractAnthropicNonStreaming(body, 1500);
    expect(m.provider).toBe("anthropic");
    expect(m.streaming).toBe(false);
    expect(m.input_tokens).toBe(12);
    expect(m.output_tokens).toBe(6);
    expect(m.cache_creation_tokens).toBe(0);
    expect(m.cache_read_tokens).toBe(0);
    expect(m.total_input_tokens).toBe(12); // 12 + 0 + 0
    expect(m.total_output_tokens).toBe(6);
    expect(m.thinking_tokens).toBeNull();
    expect(m.ttft_ms).toBeNull(); // not derivable non-streaming
    expect(m.duration_ms).toBe(1500);
    expect(m.usage_missing).toBe(false);
  });

  test("cache creation on first call (cache_creation_input_tokens set)", () => {
    const body = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 2579,
        cache_read_input_tokens: 0,
      },
    };
    const m = extractAnthropicNonStreaming(body, 2000);
    expect(m.input_tokens).toBe(100);
    expect(m.cache_creation_tokens).toBe(2579);
    expect(m.cache_read_tokens).toBe(0);
    expect(m.total_input_tokens).toBe(2679); // 100 + 2579 + 0
    expect(m.output_tokens).toBe(50);
  });

  test("cache hit (cache_read_input_tokens set, creation = 0)", () => {
    const body = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 2579,
      },
    };
    const m = extractAnthropicNonStreaming(body, 2000);
    expect(m.cache_creation_tokens).toBe(0);
    expect(m.cache_read_tokens).toBe(2579);
    expect(m.total_input_tokens).toBe(2679); // 100 + 0 + 2579
  });

  test("null cache fields treated as 0 (no caching active)", () => {
    const body = {
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: null,
      },
    };
    const m = extractAnthropicNonStreaming(body, 1000);
    expect(m.cache_creation_tokens).toBe(0);
    expect(m.cache_read_tokens).toBe(0);
    expect(m.total_input_tokens).toBe(100);
  });

  test("thinking tokens captured from output_tokens_details", () => {
    const body = {
      usage: {
        input_tokens: 100,
        output_tokens: 200,
        output_tokens_details: { thinking_tokens: 150 },
      },
    };
    const m = extractAnthropicNonStreaming(body, 3000);
    expect(m.thinking_tokens).toBe(150);
    expect(m.output_tokens).toBe(200); // total still 200 (thinking is inclusive)
  });

  test("thinking_block_count counts thinking blocks in non-streaming content", () => {
    const body = {
      usage: { input_tokens: 100, output_tokens: 200 },
      content: [
        { type: "thinking", thinking: "reasoning..." },
        { type: "text", text: "answer" },
        { type: "thinking", thinking: "more reasoning" },
      ],
    };
    const m = extractAnthropicNonStreaming(body, 3000);
    expect(m.thinking_block_count).toBeNull();
    expect(m.thinking_tokens).toBeNull();
  });

  test("thinking_block_count is 0 when non-streaming content has no thinking blocks", () => {
    const body = {
      usage: { input_tokens: 100, output_tokens: 200 },
      content: [{ type: "text", text: "answer" }],
    };
    const m = extractAnthropicNonStreaming(body, 3000);
    expect(m.thinking_block_count).toBeNull();
  });

  test("thinking_block_count is null when non-streaming content array absent", () => {
    const body = { usage: { input_tokens: 100, output_tokens: 200 } };
    const m = extractAnthropicNonStreaming(body, 3000);
    expect(m.thinking_block_count).toBeNull();
  });

  test("usage absent → usage_missing = true", () => {
    const body = { id: "msg_1", content: [] };
    const m = extractAnthropicNonStreaming(body, 500);
    expect(m.usage_missing).toBe(true);
    expect(m.input_tokens).toBeNull();
    expect(m.output_tokens).toBeNull();
    expect(m.tps).toBeNull();
  });

  test("TPS computed from duration when output > 0", () => {
    const body = { usage: { input_tokens: 10, output_tokens: 100 } };
    const m = extractAnthropicNonStreaming(body, 1000);
    // Non-streaming: TPS = output / duration = 100 / 1s = 100 tps
    expect(m.tps).toBeCloseTo(100, 1);
  });

  test("TPS null when output is 0", () => {
    const body = { usage: { input_tokens: 10, output_tokens: 0 } };
    const m = extractAnthropicNonStreaming(body, 1000);
    expect(m.tps).toBeNull();
  });
});

describe("Anthropic streaming usage extraction", () => {
  // Helper: build a realistic streaming event sequence with timestamps.
  function buildEvents(
    overrides: Partial<{
      inputTokens: number;
      cacheCreate: number | null;
      cacheRead: number | null;
      outputTokens: number;
      thinkingTokens: number | null;
      ttftMs: number;
      perDeltaMs: number;
      deltaCount: number;
      messageDeltaCacheCreate: number | null; // simulate message_delta re-carrying cache fields
      messageDeltaCacheRead: number | null;
      messageDeltaInputTokens: number | null; // simulate message_delta re-carrying input_tokens
    }> = {},
  ): { events: AnthropicSseEvent[]; startedAt: number } {
    const o = {
      inputTokens: 100,
      cacheCreate: 0 as number | null,
      cacheRead: 0 as number | null,
      outputTokens: 50,
      thinkingTokens: null as number | null,
      ttftMs: 100,
      perDeltaMs: 50,
      deltaCount: 5,
      messageDeltaCacheCreate: null as number | null,
      messageDeltaCacheRead: null as number | null,
      messageDeltaInputTokens: null as number | null,
      ...overrides,
    };
    const startedAt = 1000;
    let t = startedAt;

    const events: AnthropicSseEvent[] = [];

    // message_start
    events.push({ type: "message_start", message: { usage: {} }, received_at: t });
    const startUsage: Record<string, unknown> = { input_tokens: o.inputTokens, output_tokens: 1 };
    if (o.cacheCreate != null) startUsage.cache_creation_input_tokens = o.cacheCreate;
    if (o.cacheRead != null) startUsage.cache_read_input_tokens = o.cacheRead;
    events[0].message = { usage: startUsage };

    // content_block_start
    t += o.ttftMs;
    events.push({
      type: "content_block_start",
      delta: { type: undefined },
      received_at: t,
    });

    // content_block_delta events (the ones that mark TTFT)
    for (let i = 0; i < o.deltaCount; i++) {
      t += o.perDeltaMs;
      events.push({
        type: "content_block_delta",
        delta: { type: "text_delta" },
        received_at: t,
      });
    }

    // content_block_stop
    events.push({ type: "content_block_stop", received_at: t });

    // message_delta with cumulative usage
    t += 10;
    const deltaUsage: Record<string, unknown> = { output_tokens: o.outputTokens };
    if (o.messageDeltaCacheCreate != null)
      deltaUsage.cache_creation_input_tokens = o.messageDeltaCacheCreate;
    if (o.messageDeltaCacheRead != null)
      deltaUsage.cache_read_input_tokens = o.messageDeltaCacheRead;
    if (o.messageDeltaInputTokens != null) deltaUsage.input_tokens = o.messageDeltaInputTokens;
    if (o.thinkingTokens != null)
      deltaUsage.output_tokens_details = { thinking_tokens: o.thinkingTokens };
    events.push({
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: deltaUsage,
      received_at: t,
    });

    // message_stop
    events.push({ type: "message_stop", received_at: t });

    return { events, startedAt };
  }

  test("basic streaming: input from message_start, output from message_delta", () => {
    const { events, startedAt } = buildEvents({
      inputTokens: 100,
      outputTokens: 50,
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.provider).toBe("anthropic");
    expect(m.streaming).toBe(true);
    expect(m.input_tokens).toBe(100);
    expect(m.output_tokens).toBe(50); // cumulative from message_delta
    expect(m.cache_creation_tokens).toBe(0);
    expect(m.cache_read_tokens).toBe(0);
    expect(m.total_input_tokens).toBe(100);
    expect(m.usage_missing).toBe(false);
  });

  test("TTFT derived from first content_block_delta (not message_start)", () => {
    const { events, startedAt } = buildEvents({
      ttftMs: 200,
      perDeltaMs: 50,
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.ttft_ms).not.toBeNull();
    // message_start at t=1000, content_block_start at t=1200, first delta at t=1250
    // TTFT = first delta timestamp - startedAt = 1250 - 1000 = 250
    expect(m.ttft_ms).toBe(250);
  });

  test("TTFT null if no content_block_delta events (empty response)", () => {
    const startedAt = 1000;
    const events: AnthropicSseEvent[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10, output_tokens: 1 } },
        received_at: 1000,
      },
      {
        type: "message_delta",
        usage: { output_tokens: 0 },
        delta: { stop_reason: "end_turn" },
        received_at: 1050,
      },
      { type: "message_stop", received_at: 1060 },
    ];
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.ttft_ms).toBeNull();
    expect(m.output_tokens).toBe(0);
  });

  test("cache creation: seeded at message_start, preserved through message_delta", () => {
    const { events, startedAt } = buildEvents({
      cacheCreate: 2579,
      cacheRead: 0,
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.cache_creation_tokens).toBe(2579);
    expect(m.cache_read_tokens).toBe(0);
    expect(m.total_input_tokens).toBe(2679); // 100 + 2579 + 0
  });

  test("cache hit: cache_read from message_start, creation = 0", () => {
    const { events, startedAt } = buildEvents({
      cacheCreate: 0,
      cacheRead: 2579,
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.cache_read_tokens).toBe(2579);
    expect(m.cache_creation_tokens).toBe(0);
    expect(m.total_input_tokens).toBe(2679);
  });

  test("message_delta cache fields OVERWRITE message_start when non-null (cumulative)", () => {
    // message_start says cache_create=100, message_delta says cache_create=200 (updated)
    const { events, startedAt } = buildEvents({
      cacheCreate: 100,
      messageDeltaCacheCreate: 200,
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.cache_creation_tokens).toBe(200); // overwritten by message_delta
  });

  test("message_delta cache fields DO NOT clobber when null (preserves message_start)", () => {
    // This is the critical SDK behavior: null in message_delta must not erase message_start values
    const { events, startedAt } = buildEvents({
      cacheCreate: 2579,
      cacheRead: 100,
      // message_delta carries NO cache fields (they'll be undefined → null check preserves)
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.cache_creation_tokens).toBe(2579); // preserved, NOT clobbered to 0
    expect(m.cache_read_tokens).toBe(100);
  });

  test("message_delta input_tokens overwrites when non-null", () => {
    const { events, startedAt } = buildEvents({
      inputTokens: 100,
      messageDeltaInputTokens: 150,
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.input_tokens).toBe(150); // overwritten
  });

  test("thinking_tokens captured from message_delta.output_tokens_details", () => {
    const { events, startedAt } = buildEvents({
      thinkingTokens: 150,
      outputTokens: 200,
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.thinking_tokens).toBe(150);
    expect(m.output_tokens).toBe(200);
  });

  test("thinking_block_count tracks thinking content blocks even when output_tokens_details absent", () => {
    const startedAt = 1000;
    const events: AnthropicSseEvent[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10, output_tokens: 1 } },
        received_at: 1000,
      },
      { type: "content_block_start", content_block: { type: "thinking" }, received_at: 1100 },
      {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "hm" },
        received_at: 1200,
      },
      { type: "content_block_stop", received_at: 1300 },
      { type: "content_block_start", content_block: { type: "text" }, received_at: 1400 },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" }, received_at: 1500 },
      { type: "content_block_stop", received_at: 1600 },
      {
        type: "message_delta",
        usage: { output_tokens: 50 },
        delta: { stop_reason: "end_turn" },
        received_at: 1700,
      },
      { type: "message_stop", received_at: 1700 },
    ];
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.thinking_tokens).toBeNull();
    expect(m.thinking_block_count).toBeNull();
    expect(m.output_tokens).toBe(50);
  });

  test("thinking_block_count counts multiple thinking blocks", () => {
    const startedAt = 1000;
    const events: AnthropicSseEvent[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10, output_tokens: 1 } },
        received_at: 1000,
      },
      { type: "content_block_start", content_block: { type: "thinking" }, received_at: 1100 },
      { type: "content_block_stop", received_at: 1200 },
      { type: "content_block_start", content_block: { type: "thinking" }, received_at: 1300 },
      { type: "content_block_stop", received_at: 1400 },
      { type: "content_block_start", content_block: { type: "text" }, received_at: 1500 },
      { type: "content_block_stop", received_at: 1600 },
      {
        type: "message_delta",
        usage: { output_tokens: 80 },
        delta: { stop_reason: "end_turn" },
        received_at: 1700,
      },
      { type: "message_stop", received_at: 1700 },
    ];
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.thinking_block_count).toBeNull();
  });

  test("thinking_block_count is 0 when no thinking content blocks", () => {
    const startedAt = 1000;
    const events: AnthropicSseEvent[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10, output_tokens: 1 } },
        received_at: 1000,
      },
      { type: "content_block_start", content_block: { type: "text" }, received_at: 1100 },
      { type: "content_block_delta", delta: { type: "text_delta", text: "hi" }, received_at: 1200 },
      { type: "content_block_stop", received_at: 1300 },
      {
        type: "message_delta",
        usage: { output_tokens: 20 },
        delta: { stop_reason: "end_turn" },
        received_at: 1400,
      },
      { type: "message_stop", received_at: 1400 },
    ];
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.thinking_block_count).toBeNull();
  });

  test("ping events ignored (no usage data)", () => {
    const startedAt = 1000;
    const events: AnthropicSseEvent[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10, output_tokens: 1 } },
        received_at: 1000,
      },
      { type: "ping", received_at: 1050 },
      { type: "ping", received_at: 1100 },
      {
        type: "content_block_delta",
        delta: { type: "text_delta" },
        received_at: 1200,
      },
      {
        type: "message_delta",
        usage: { output_tokens: 30 },
        delta: { stop_reason: "end_turn" },
        received_at: 1300,
      },
      { type: "message_stop", received_at: 1310 },
    ];
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.input_tokens).toBe(10);
    expect(m.output_tokens).toBe(30);
    expect(m.usage_missing).toBe(false);
    expect(m.ttft_ms).toBe(200); // 1200 - 1000
  });

  test("TPS computed from (duration - TTFT) for streaming", () => {
    const { events, startedAt } = buildEvents({
      outputTokens: 100,
      ttftMs: 100,
      perDeltaMs: 120,
      deltaCount: 10,
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.output_tokens).toBe(100);
    expect(m.ttft_ms).toBe(220); // first delta at startedAt + ttftMs + perDeltaMs = 1000+100+120 = 1220 → 220
    expect(m.duration_ms).not.toBeNull();
    // TPS = output / ((duration - ttft) / 1000)
    const genMs = (m.duration_ms ?? 0) - (m.ttft_ms ?? 0);
    const expectedTps = (100 / genMs) * 1000;
    expect(m.tps).toBeCloseTo(expectedTps, 1);
    expect(m.tps).toBeGreaterThan(0);
  });

  test("TPS is null for sub-1-second generation; output tokens still recorded", () => {
    const { events, startedAt } = buildEvents({
      outputTokens: 100,
      ttftMs: 100,
      perDeltaMs: 10,
      deltaCount: 10,
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.output_tokens).toBe(100);
    expect(m.tps).toBeNull();
  });

  test("usage_missing when no message_start or message_delta usage", () => {
    const startedAt = 1000;
    const events: AnthropicSseEvent[] = [
      { type: "message_start", message: {}, received_at: 1000 },
      { type: "message_stop", received_at: 1100 },
    ];
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.usage_missing).toBe(true);
    expect(m.input_tokens).toBeNull();
    expect(m.output_tokens).toBeNull();
  });

  test("message_start output_tokens (placeholder ~1) NOT used as final output", () => {
    // Critical: message_start.output_tokens is ~1, must NOT be the final count
    const { events, startedAt } = buildEvents({
      outputTokens: 510,
    });
    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.output_tokens).toBe(510);
    expect(m.output_tokens).not.toBe(1);
  });
});
