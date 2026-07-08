// Integration test: end-to-end usage extraction pipeline.
// Verifies: proxy → extraction → DB → REST endpoint.
//
// Complements usage-dashboard.test.ts (which tests summarizeByModel + db.getModelStats
// in-process) by testing the FULL pipeline through HTTP + the real proxy.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CaptureRow } from "../src/types.js";
import { type MockUpstreamHandle, startMockLlmUpstream } from "./helpers/mock-llm-upstream";
import { type ProxyHandle, startProxy } from "./helpers/proxy";
import type { ModelSummary } from "./helpers/usage-extractors";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Fetch the most recent capture matching the given path, with full detail. */
async function getLatestCapture(proxy: ProxyHandle, path: string): Promise<CaptureRow | null> {
  await sleep(200); // wait for write-behind queue flush
  const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=50`);
  const captures = (await listRes.json()) as Array<{ id: number; path: string }>;
  const cap = captures.find((c) => c.path === path);
  if (!cap) return null;
  const detailRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures/${cap.id}`);
  return (await detailRes.json()) as CaptureRow;
}

// ─── Happy paths: proxy → extraction → DB → REST ───────────────────────────

describe("Integration: usage extraction pipeline (happy paths)", () => {
  let upstream: MockUpstreamHandle;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    upstream = await startMockLlmUpstream();
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      STAMP_CACHE_TTL_ENABLED: "false",
      WARMER_ENABLED: "false",
    });
  });

  afterAll(async () => {
    await proxy.kill();
    await upstream.close();
  });

  // Test 1: empty DB
  test("model-stats returns empty array when no captures exist", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/model-stats`);
    expect(res.status).toBe(200);
    const stats = await res.json();
    expect(Array.isArray(stats)).toBe(true);
    expect(stats).toEqual([]);
  });

  // Test 2: Anthropic non-streaming
  test("Anthropic non-streaming request populates usage columns in DB", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 50,
        messages: [{ role: "user", content: "Hello integration test" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const cap = await getLatestCapture(proxy, "/v1/messages");
    expect(cap).not.toBeNull();
    expect(cap!.model).toBe("claude-sonnet-4-5");
    expect(cap!.provider).toBe("anthropic");
    expect(cap!.streaming).toBe(0);
    expect(cap!.input_tokens).not.toBeNull();
    expect(cap!.output_tokens).not.toBeNull();
    expect(cap!.input_tokens! > 0).toBe(true);
    expect(cap!.output_tokens! > 0).toBe(true);
  });

  // Test 3: Anthropic streaming TTFT
  test("Anthropic streaming request populates ttft_ms", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 50,
        stream: true,
        system: [
          { type: "text", text: "Context for TTFT test", cache_control: { type: "ephemeral" } },
        ],
        messages: [{ role: "user", content: "Stream test" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const cap = await getLatestCapture(proxy, "/v1/messages");
    expect(cap).not.toBeNull();
    expect(cap!.model).toBe("claude-sonnet-4-5");
    expect(cap!.streaming).toBe(1);
    expect(cap!.ttft_ms).not.toBeNull();
    expect(cap!.ttft_ms! > 0).toBe(true);
  });

  // Test 4: OpenAI non-streaming
  test("OpenAI non-streaming request populates usage columns", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 50,
        messages: [{ role: "user", content: "Hello OpenAI" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const cap = await getLatestCapture(proxy, "/v1/chat/completions");
    expect(cap).not.toBeNull();
    expect(cap!.model).toBe("gpt-4o");
    expect(cap!.provider).toBe("openai");
    expect(cap!.input_tokens).not.toBeNull();
    expect(cap!.output_tokens).not.toBeNull();
    expect(cap!.input_tokens! > 0).toBe(true);
    expect(cap!.output_tokens! > 0).toBe(true);
  });

  // Test 5: model-stats endpoint — relies on captures from Tests 2-4 (same describe block).
  test("model-stats endpoint returns ModelSummary with percentile stats", async () => {
    await sleep(200);
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/model-stats`);
    expect(res.status).toBe(200);
    const stats = (await res.json()) as ModelSummary[];
    expect(Array.isArray(stats)).toBe(true);
    expect(stats.length).toBeGreaterThan(0);

    const claudeStat = stats.find((s) => s.model.includes("claude"));
    expect(claudeStat).toBeDefined();
    expect(claudeStat!.provider).toBe("anthropic");
    expect(claudeStat!.request_count).toBeGreaterThanOrEqual(2);
    expect(claudeStat!.streaming_count).toBeGreaterThan(0);

    const ttft = claudeStat!.ttft_ms;
    expect(ttft).not.toBeNull();
    expect(ttft!.count).toBeGreaterThan(0);
    expect(ttft!.min).toBeGreaterThan(0);
    expect(ttft!.max).toBeGreaterThanOrEqual(ttft!.min);
    expect(ttft!.p10).toBeGreaterThanOrEqual(ttft!.min);
    expect(ttft!.p50).toBeGreaterThanOrEqual(ttft!.p10);
    expect(ttft!.p95).toBeGreaterThanOrEqual(ttft!.p50);
    expect(ttft!.max).toBeGreaterThanOrEqual(ttft!.p95);
    expect(ttft!.mean).toBeGreaterThan(0);

    const inputStats = claudeStat!.input_tokens;
    expect(inputStats).not.toBeNull();
    expect(inputStats!.count).toBeGreaterThan(0);
    expect(inputStats!.min).toBeGreaterThan(0);

    const outputStats = claudeStat!.output_tokens;
    expect(outputStats).not.toBeNull();
    expect(outputStats!.count).toBeGreaterThan(0);

    const openaiStat = stats.find((s) => s.model === "gpt-4o");
    expect(openaiStat).toBeDefined();
    expect(openaiStat!.provider).toBe("openai");
    expect(openaiStat!.request_count).toBeGreaterThanOrEqual(1);
  });
});

// ─── Error paths: malformed + HTTP 500 ─────────────────────────────────────

describe("Integration: malformed response handling", () => {
  let customUpstream: ReturnType<typeof Bun.serve>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    customUpstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Internal Server Error", {
          status: 200,
          headers: { "content-type": "text/plain" },
        });
      },
    });
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${customUpstream.port}`,
      STAMP_CACHE_TTL_ENABLED: "false",
      WARMER_ENABLED: "false",
    });
  });

  afterAll(async () => {
    await proxy.kill();
    customUpstream.stop();
    await sleep(100);
  });

  // Test 6: malformed response (200 with non-JSON body)
  test("non-JSON 200 response is captured with null usage columns", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 50,
        messages: [{ role: "user", content: "Test malformed response" }],
      }),
    });
    expect(res.status).toBe(200);
    await res.text();

    const cap = await getLatestCapture(proxy, "/v1/messages");
    expect(cap).not.toBeNull();
    expect(cap!.response_status).toBe(200);
    // extractUsage throws on JSON.parse(responseBody) → usage=null, model=null
    expect(cap!.model).toBeNull();
    expect(cap!.input_tokens).toBeNull();
    expect(cap!.output_tokens).toBeNull();
    expect(cap!.usage_missing).toBeNull();
  });
});

describe("Integration: HTTP 500 error path", () => {
  let customUpstream: ReturnType<typeof Bun.serve>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    customUpstream = Bun.serve({
      port: 0,
      fetch() {
        return new Response("Internal Server Error", {
          status: 500,
          headers: { "content-type": "text/plain" },
        });
      },
    });
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${customUpstream.port}`,
      STAMP_CACHE_TTL_ENABLED: "false",
      WARMER_ENABLED: "false",
    });
  });

  afterAll(async () => {
    await proxy.kill();
    customUpstream.stop();
    await sleep(100);
  });

  // Test 7: HTTP 500 error path
  test("HTTP 500 response is captured with null usage columns", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
        max_tokens: 50,
        messages: [{ role: "user", content: "Test 500 error" }],
      }),
    });
    expect(res.status).toBe(500);
    await res.text();

    const cap = await getLatestCapture(proxy, "/v1/messages");
    expect(cap).not.toBeNull();
    expect(cap!.response_status).toBe(500);
    // Non-JSON body → extractUsage throws → usage=null, model=null
    expect(cap!.model).toBeNull();
    expect(cap!.input_tokens).toBeNull();
    expect(cap!.output_tokens).toBeNull();
    expect(cap!.usage_missing).toBeNull();
  });
});
