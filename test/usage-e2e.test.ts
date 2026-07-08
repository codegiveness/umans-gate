// End-to-end test: verify the proxy captures response bodies intact so
// usage extraction works on captured data. This proves the capture pipeline
// preserves the exact bytes needed for token attribution.
//
// Flow: client → proxy → mock LLM upstream (with usage) → capture DB → extract

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type MockUpstreamHandle, startMockLlmUpstream } from "./helpers/mock-llm-upstream";
import { type ProxyHandle, startProxy } from "./helpers/proxy";
import {
  extractAnthropicNonStreaming,
  extractAnthropicStreaming,
  extractOpenAiNonStreaming,
  extractOpenAiStreaming,
  parseAnthropicSse,
  parseOpenAiSse,
} from "./helpers/usage-extractors";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let upstream: MockUpstreamHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  upstream = await startMockLlmUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${upstream.port}`,
    STAMP_CACHE_TTL_ENABLED: "false", // transparent — we want to test extraction, not stamping
  });
});

afterAll(async () => {
  await proxy.kill();
  await upstream.close();
});

/** Fetch a capture from the REST API and return its response_body. */
async function getCaptureBody(
  path: string,
): Promise<{ body: string; duration_ms: number; isSse: boolean } | null> {
  await sleep(200); // wait for flush
  const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=20`);
  const captures = (await listRes.json()) as Array<{ id: number; path: string }>;
  const cap = captures.find((c) => c.path === path);
  if (!cap) return null;
  const detailRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures/${cap.id}`);
  const detail = (await detailRes.json()) as {
    response_body: string;
    duration_ms: number;
    is_sse: number;
  };
  return {
    body: detail.response_body ?? "",
    duration_ms: detail.duration_ms ?? 0,
    isSse: detail.is_sse === 1,
  };
}

describe("E2E: Anthropic non-streaming usage extraction from proxy capture", () => {
  test("captured response_body yields correct usage metrics", async () => {
    const path = "/v1/messages";
    const reqBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 50,
      messages: [{ role: "user", content: "Hello" }],
    };
    const res = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.usage).toBeDefined();

    const cap = await getCaptureBody(path);
    expect(cap).not.toBeNull();
    expect(cap!.body).not.toBe("");

    // The captured body should be parseable and yield the same usage
    const parsed = JSON.parse(cap!.body);
    const m = extractAnthropicNonStreaming(parsed, cap!.duration_ms);
    expect(m.usage_missing).toBe(false);
    expect(m.input_tokens).toBeGreaterThan(0);
    expect(m.output_tokens).toBeGreaterThan(0);
    expect(m.provider).toBe("anthropic");
    expect(m.streaming).toBe(false);
  });
});

describe("E2E: Anthropic streaming usage extraction from proxy capture", () => {
  test("captured SSE body yields correct usage metrics with TTFT", async () => {
    const path = "/v1/messages";
    const reqBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "Hello" }],
    };
    const res = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    // Consume the full stream
    const text = await res.text();
    expect(text).toContain("message_start");
    expect(text).toContain("message_delta");

    const cap = await getCaptureBody(path);
    expect(cap).not.toBeNull();
    expect(cap!.isSse).toBe(true);

    // Parse the captured SSE body and extract usage
    // For TTFT we need timestamps — in this e2e test we approximate by
    // using duration_ms / event_count as per-event spacing
    const events = parseAnthropicSse(cap!.body);
    expect(events.length).toBeGreaterThan(0);

    // Since we don't have real per-event timestamps from the capture,
    // use synthetic evenly-spaced timestamps based on duration
    const eventCount = events.length;
    const perEvent = cap!.duration_ms / Math.max(eventCount, 1);
    const chunkTimes = events.map((_, i) => 0 + Math.round(i * perEvent));

    const eventsWithTimes = events.map((ev, i) => ({ ...ev, received_at: chunkTimes[i] }));
    const mTimed = extractAnthropicStreaming(eventsWithTimes, 0);

    expect(mTimed.usage_missing).toBe(false);
    expect(mTimed.input_tokens).toBeGreaterThan(0);
    expect(mTimed.output_tokens).toBeGreaterThan(0);
    expect(mTimed.streaming).toBe(true);
    // TTFT should be derivable since we have content_block_delta events
    expect(mTimed.ttft_ms).not.toBeNull();
    expect(mTimed.ttft_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("E2E: OpenAI non-streaming usage extraction from proxy capture", () => {
  test("captured response_body yields correct usage metrics", async () => {
    const path = "/v1/chat/completions";
    const reqBody = {
      model: "gpt-4o",
      max_tokens: 50,
      messages: [{ role: "user", content: "Hello" }],
    };
    const res = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.usage).toBeDefined();

    const cap = await getCaptureBody(path);
    expect(cap).not.toBeNull();

    const parsed = JSON.parse(cap!.body);
    const m = extractOpenAiNonStreaming(parsed, cap!.duration_ms);
    expect(m.usage_missing).toBe(false);
    expect(m.input_tokens).toBeGreaterThan(0);
    expect(m.output_tokens).toBeGreaterThan(0);
    expect(m.provider).toBe("openai");
    expect(m.streaming).toBe(false);
  });
});

describe("E2E: OpenAI streaming usage extraction from proxy capture", () => {
  test("with include_usage: captured SSE yields full usage", async () => {
    const path = "/v1/chat/completions";
    const reqBody = {
      model: "gpt-4o",
      max_tokens: 50,
      stream: true,
      stream_options: { include_usage: true },
      messages: [{ role: "user", content: "Hello" }],
    };
    const res = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("data: [DONE]");

    const cap = await getCaptureBody(path);
    expect(cap).not.toBeNull();
    expect(cap!.isSse).toBe(true);

    const chunks = parseOpenAiSse(cap!.body);
    expect(chunks.length).toBeGreaterThan(0);

    // Synthesize timestamps for TTFT
    const perChunk = cap!.duration_ms / Math.max(chunks.length, 1);
    const chunkTimes = chunks.map((_, i) => 0 + Math.round(i * perChunk));
    const chunksTimed = chunks.map((ch, i) => ({ ...ch, received_at: chunkTimes[i] }));

    const m = extractOpenAiStreaming(chunksTimed, 0);
    expect(m.usage_missing).toBe(false);
    expect(m.input_tokens).toBeGreaterThan(0);
    expect(m.output_tokens).toBeGreaterThan(0);
    expect(m.streaming).toBe(true);
    expect(m.ttft_ms).not.toBeNull();
  });

  test("WITHOUT include_usage: usage_missing = true on captured SSE", async () => {
    const path = "/v1/chat/completions";
    const reqBody = {
      model: "gpt-4o",
      max_tokens: 50,
      stream: true,
      // NO stream_options.include_usage
      messages: [{ role: "user", content: "Hello" }],
    };
    const res = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(res.status).toBe(200);
    await res.text();

    const cap = await getCaptureBody(path);
    expect(cap).not.toBeNull();

    const chunks = parseOpenAiSse(cap!.body);
    const m = extractOpenAiStreaming(chunks, 0);
    expect(m.usage_missing).toBe(true);
    expect(m.output_tokens).toBeNull();
  });
});
