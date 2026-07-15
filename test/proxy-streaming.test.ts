// Characterization tests for handleProxy's streaming/SSE response path and capture behavior.
// These tests pin the current observable behavior before handleProxy is decomposed.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { CaptureRow } from "../src/types.js";
import { type MockUpstreamHandle, startMockLlmUpstream } from "./helpers/mock-llm-upstream";
import { type ProxyHandle, startProxy } from "./helpers/proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let upstream: MockUpstreamHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  upstream = await startMockLlmUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${upstream.port}`,
    STAMP_CACHE_TTL_ENABLED: "false",
    WARMER_ENABLED: "false",
    RELEASE_COOLDOWN_MS: "0",
  });
});

afterAll(async () => {
  await proxy.kill();
  await upstream.close();
});

/** Fetch the most recent capture matching the given path, with full detail. */
async function getLatestCapture(path: string): Promise<CaptureRow | null> {
  await sleep(250); // wait for write-behind queue flush
  const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=50`);
  const captures = (await listRes.json()) as Array<{ id: number; path: string }>;
  const cap = captures.find((c) => c.path === path);
  if (!cap) return null;
  const detailRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures/${cap.id}`);
  return (await detailRes.json()) as CaptureRow;
}

describe("proxy streaming/SSE characterization", () => {
  test("streaming Anthropic request returns full SSE response", async () => {
    const path = "/v1/messages";
    const reqBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "Hello streaming test" }],
    };

    const res = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();

    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain("event: message_delta");
    expect(body).toContain('"usage":');
    expect(body).toContain("event: message_stop");
  });

  test("capture is marked done and contains full SSE response body with usage", async () => {
    const path = "/v1/messages";
    const reqBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "Capture streaming test" }],
    };

    const res = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(res.status).toBe(200);
    await res.text();

    const cap = await getLatestCapture(path);
    expect(cap).not.toBeNull();
    expect(cap!.state).toBe("done");
    expect(cap!.response_status).toBe(200);
    expect(cap!.is_sse).toBe(1);
    expect(cap!.response_body).not.toBeNull();
    expect(cap!.response_body).toContain("event: message_start");
    expect(cap!.response_body).toContain("event: content_block_delta");
    expect(cap!.response_body).toContain("event: message_delta");
    expect(cap!.response_body).toContain("event: message_stop");
    expect(cap!.model).toBe("claude-sonnet-4-5");
    expect(cap!.input_tokens).not.toBeNull();
    expect(cap!.input_tokens! > 0).toBe(true);
    expect(cap!.output_tokens).not.toBeNull();
    expect(cap!.output_tokens! > 0).toBe(true);
  });

  test("permit is released and a second streaming request succeeds immediately", async () => {
    const path = "/v1/messages";
    const reqBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "Permit release test" }],
    };

    const first = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(first.status).toBe(200);
    await first.text();

    const second = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...reqBody, messages: [{ role: "user", content: "Second" }] }),
    });
    expect(second.status).toBe(200);

    const body = await second.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: message_stop");

    expect(upstream.getCallCount()).toBeGreaterThanOrEqual(2);
  });

  test("non-streaming Anthropic request returns JSON and capture has usage", async () => {
    const path = "/v1/messages";
    const reqBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 50,
      stream: false,
      messages: [{ role: "user", content: "Non-streaming test" }],
    };

    const res = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const json = (await res.json()) as {
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    expect(json.usage).toBeDefined();
    expect(json.usage!.input_tokens).toBeGreaterThan(0);
    expect(json.usage!.output_tokens).toBeGreaterThan(0);

    const cap = await getLatestCapture(path);
    expect(cap).not.toBeNull();
    expect(cap!.state).toBe("done");
    expect(cap!.response_status).toBe(200);
    expect(cap!.is_sse).toBe(0);
    expect(cap!.model).toBe("claude-sonnet-4-5");
    expect(cap!.input_tokens).not.toBeNull();
    expect(cap!.input_tokens! > 0).toBe(true);
    expect(cap!.output_tokens).not.toBeNull();
    expect(cap!.output_tokens! > 0).toBe(true);
  });

  test("streaming capture duration_ms and ttft_ms are populated", async () => {
    const path = "/v1/messages";
    const reqBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "Duration and TTFT test" }],
    };

    const res = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(res.status).toBe(200);
    await res.text();

    const cap = await getLatestCapture(path);
    expect(cap).not.toBeNull();
    expect(cap!.state).toBe("done");
    expect(cap!.duration_ms).toBeGreaterThan(0);
    expect(cap!.ttft_ms).not.toBeNull();
    expect(cap!.ttft_ms! > 0).toBe(true);
  });

  test("permit is released even when streaming response body is discarded", async () => {
    const path = "/v1/messages";
    const reqBody = {
      model: "claude-sonnet-4-5",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "Discard body test" }],
    };

    // Regression: discard the streaming response without consuming the body.
    // Default concurrency hard cap is 1, so a leaked permit would block the next request.
    const first = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(first.status).toBe(200);

    const second = await fetch(`${proxy.baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...reqBody,
        messages: [{ role: "user", content: "Second after discard" }],
      }),
    });
    expect(second.status).toBe(200);

    const body = await second.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: message_stop");
  });
});
