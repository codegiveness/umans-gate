// Tests for chunk-based SSE parsing (Bug #3 fix) and TTFT from any
// content_block_delta type (Bug #2 fix).

import { describe, expect, test } from "bun:test";
import {
  type AnthropicSseEvent,
  extractAnthropicStreaming,
  extractOpenAiStreaming,
  type OpenAIStreamChunk,
  parseAnthropicSse,
  parseOpenAiSse,
  type TimedChunk,
} from "./helpers/usage-extractors";

describe("parseAnthropicSse with chunks parameter", () => {
  test("multi-event chunk: all events get the chunk's timestamp", () => {
    const sseBody = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" there"}}',
      "",
      "",
    ].join("\n");

    const ts = 1000000;
    const chunks: TimedChunk[] = [{ text: sseBody, time: ts }];
    const events = parseAnthropicSse(chunks);

    expect(events.length).toBe(3);
    expect(events[0].type).toBe("message_start");
    expect(events[0].received_at).toBe(ts);
    expect(events[1].type).toBe("content_block_delta");
    expect(events[1].received_at).toBe(ts);
    expect(events[2].type).toBe("content_block_delta");
    expect(events[2].received_at).toBe(ts);
  });

  test("SSE event split across two chunks: event is NOT lost", () => {
    const part1 = ["event: content_block_delta", 'data: {"type":"content_block_del'].join("\n");

    const part2 = ['ta","delta":{"type":"text_delta","text":"Hi"}}', "", ""].join("\n");

    const chunks: TimedChunk[] = [
      { text: part1, time: 1000 },
      { text: part2, time: 2000 },
    ];
    const events = parseAnthropicSse(chunks);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("content_block_delta");
    expect(events[0].delta?.type).toBe("text_delta");
    expect(events[0].delta?.text).toBe("Hi");
    expect(events[0].received_at).toBe(2000);
  });

  test("multiple events split across chunks with partial boundaries", () => {
    const chunk1Text = [
      "event: message_start",
      'data: {"type":"message_start","message":{"usage":{"input_tokens":5}}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"thin',
    ].join("\n");

    const chunk2Text = [
      'king_delta","thinking":"Let me think"}}',
      "",
      "event: content_block_delta",
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Answer"}}',
      "",
      "",
    ].join("\n");

    const chunks: TimedChunk[] = [
      { text: chunk1Text, time: 1000 },
      { text: chunk2Text, time: 2000 },
    ];
    const events = parseAnthropicSse(chunks);

    expect(events.length).toBe(3);
    expect(events[0].type).toBe("message_start");
    expect(events[0].received_at).toBe(1000);
    expect(events[1].type).toBe("content_block_delta");
    expect(events[1].delta?.type).toBe("thinking_delta");
    expect(events[1].received_at).toBe(2000);
    expect(events[2].type).toBe("content_block_delta");
    expect(events[2].delta?.type).toBe("text_delta");
    expect(events[2].received_at).toBe(2000);
  });
});

describe("TTFT from thinking_delta (Bug #2 fix)", () => {
  test("thinking_delta triggers TTFT before text_delta", () => {
    const startedAt = 5000;
    const events: AnthropicSseEvent[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10 } },
        received_at: 5100,
      },
      {
        type: "content_block_delta",
        delta: { type: "thinking_delta", thinking: "Reasoning..." },
        received_at: 5200,
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Answer" },
        received_at: 8000,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 50 },
        received_at: 8100,
      },
      { type: "message_stop", received_at: 8100 },
    ];

    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.ttft_ms).toBe(200);
  });

  test("input_json_delta triggers TTFT for tool-use-only responses", () => {
    const startedAt = 1000;
    const events: AnthropicSseEvent[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10 } },
        received_at: 1100,
      },
      {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '{"arg":' },
        received_at: 1200,
      },
      {
        type: "content_block_delta",
        delta: { type: "input_json_delta", partial_json: '"val"}' },
        received_at: 1300,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
        usage: { output_tokens: 20 },
        received_at: 1400,
      },
      { type: "message_stop", received_at: 1400 },
    ];

    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.ttft_ms).toBe(200);
  });

  test("text_delta still triggers TTFT when no thinking_delta", () => {
    const startedAt = 1000;
    const events: AnthropicSseEvent[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10 } },
        received_at: 1100,
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
        received_at: 1500,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 5 },
        received_at: 1600,
      },
      { type: "message_stop", received_at: 1600 },
    ];

    const m = extractAnthropicStreaming(events, startedAt);
    expect(m.ttft_ms).toBe(500);
  });
});

describe("duration_ms wall-clock floor (Bug #4 fix)", () => {
  test("Anthropic: duration_ms doesn't collapse when all deltas share a chunk", () => {
    const startedAt = 1000;
    const chunkTime = 5000;
    const wallClockDurationMs = 8000;
    const events: AnthropicSseEvent[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10 } },
        received_at: chunkTime,
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
        received_at: chunkTime,
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: " world" },
        received_at: chunkTime,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 50 },
        received_at: chunkTime,
      },
      { type: "message_stop", received_at: chunkTime },
    ];

    const m = extractAnthropicStreaming(events, startedAt, wallClockDurationMs);

    expect(m.ttft_ms).toBe(chunkTime - startedAt);
    expect(m.duration_ms).toBe(wallClockDurationMs);
    expect(m.duration_ms! - m.ttft_ms!).toBe(wallClockDurationMs - (chunkTime - startedAt));
    expect(m.tps).not.toBeNull();
    expect(Number.isFinite(m.tps!)).toBe(true);
  });

  test("Anthropic: backward compat without wallClockDurationMs", () => {
    const startedAt = 1000;
    const events: AnthropicSseEvent[] = [
      {
        type: "message_start",
        message: { usage: { input_tokens: 10 } },
        received_at: 1100,
      },
      {
        type: "content_block_delta",
        delta: { type: "text_delta", text: "Hello" },
        received_at: 1500,
      },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 10 },
        received_at: 2500,
      },
    ];

    const m = extractAnthropicStreaming(events, startedAt);

    expect(m.ttft_ms).toBe(500);
    expect(m.duration_ms).toBe(1500);
  });

  test("OpenAI: duration_ms doesn't collapse when all deltas share a chunk", () => {
    const startedAt = 1000;
    const chunkTime = 5000;
    const wallClockDurationMs = 8000;
    const chunks: OpenAIStreamChunk[] = [
      {
        choices: [{ delta: {} }],
        received_at: chunkTime,
      },
      {
        choices: [{ delta: { content: "Hello" } }],
        received_at: chunkTime,
      },
      {
        choices: [{ delta: { content: " world" } }],
        received_at: chunkTime,
      },
      {
        choices: [],
        usage: { completion_tokens: 50 },
        received_at: chunkTime,
      },
    ];

    const m = extractOpenAiStreaming(chunks, startedAt, wallClockDurationMs);

    expect(m.ttft_ms).toBe(chunkTime - startedAt);
    expect(m.duration_ms).toBe(wallClockDurationMs);
    expect(m.duration_ms! - m.ttft_ms!).toBe(wallClockDurationMs - (chunkTime - startedAt));
    expect(m.tps).not.toBeNull();
    expect(Number.isFinite(m.tps!)).toBe(true);
  });

  test("OpenAI: backward compat without wallClockDurationMs", () => {
    const startedAt = 1000;
    const chunks: OpenAIStreamChunk[] = [
      {
        choices: [{ delta: {} }],
        received_at: 1100,
      },
      {
        choices: [{ delta: { content: "Hello" } }],
        received_at: 1500,
      },
      {
        choices: [],
        usage: { completion_tokens: 10 },
        received_at: 2500,
      },
    ];

    const m = extractOpenAiStreaming(chunks, startedAt);

    expect(m.ttft_ms).toBe(500);
    expect(m.duration_ms).toBe(1500);
  });
});

describe("parseOpenAiSse with chunks parameter", () => {
  test("multi-event chunk: all chunks get correct timestamp", () => {
    const sseBody = [
      'data: {"choices":[{"delta":{"content":"Hi"}}]}',
      "",
      'data: {"choices":[{"delta":{"content":" there"}}]}',
      "",
      "",
    ].join("\n");

    const chunks: TimedChunk[] = [{ text: sseBody, time: 5000 }];
    const result = parseOpenAiSse(chunks);

    expect(result.length).toBe(2);
    expect(result[0].received_at).toBe(5000);
    expect(result[1].received_at).toBe(5000);
  });

  test("SSE data split across chunks: event is NOT lost", () => {
    const part1 = 'data: {"choices":[{"delta":{"co';
    const part2 = 'ntent":"Hi"}}]}\n\n';

    const chunks: TimedChunk[] = [
      { text: part1, time: 1000 },
      { text: part2, time: 2000 },
    ];
    const result = parseOpenAiSse(chunks);

    expect(result.length).toBe(1);
    expect(result[0].received_at).toBe(2000);
    expect(result[0].choices?.[0]?.delta?.content).toBe("Hi");
  });
});
