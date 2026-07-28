import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type InProcessProxyHandle, startInProcessProxy } from "../helpers/in-process-proxy";
import { type MockUpstreamHandle, startMockLlmUpstream } from "../helpers/mock-llm-upstream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let upstream: MockUpstreamHandle;
let proxy: InProcessProxyHandle;

beforeAll(async () => {
  upstream = await startMockLlmUpstream();
  proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    warmerEnabled: false,
    releaseCooldownMs: 0,
  });
});

afterAll(async () => {
  await proxy.kill();
  await upstream.close();
});

interface CaptureRow {
  id: number;
  path: string;
  provider: string | null;
  model: string | null;
  streaming: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  thinking_tokens: number | null;
  ttft_ms: number | null;
  tps: number | null;
  usage_missing: number | null;
}

async function getLatestCapture(path: string): Promise<CaptureRow | null> {
  await sleep(200);
  const rows = proxy.db.list(50) as Array<{ id: number; path: string }>;
  const cap = rows.find((r) => r.path === path);
  if (!cap) return null;
  return proxy.db.get(cap.id) as CaptureRow | null;
}

describe("Integration: usage capture flow (in-process, all 4 modes + error paths)", () => {
  test("Anthropic non-streaming populates usage columns", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
      }),
    });
    expect(res.ok).toBe(true);
    const cap = await getLatestCapture("/v1/messages");
    expect(cap).not.toBeNull();
    expect(cap!.provider).toBe("anthropic");
    expect(cap!.streaming).toBe(0);
    expect(cap!.model).not.toBeNull();
    expect(cap!.input_tokens).toBeGreaterThan(0);
    expect(cap!.output_tokens).toBeGreaterThan(0);
    expect(cap!.usage_missing).toBe(0);
  });

  test("Anthropic streaming populates ttft_ms", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
        stream: true,
      }),
    });
    expect(res.ok).toBe(true);
    // Drain the stream.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of res.body ?? emptyAsync()) {
      // drain
    }
    const cap = await getLatestCapture("/v1/messages");
    expect(cap).not.toBeNull();
    expect(cap!.provider).toBe("anthropic");
    expect(cap!.streaming).toBe(1);
    expect(cap!.ttft_ms).not.toBeNull();
    expect(cap!.ttft_ms!).toBeGreaterThanOrEqual(0);
  });

  test("OpenAI non-streaming populates usage columns", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "umans-flash",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
      }),
    });
    expect(res.ok).toBe(true);
    const cap = await getLatestCapture("/v1/chat/completions");
    expect(cap).not.toBeNull();
    expect(cap!.provider).toBe("openai");
    expect(cap!.streaming).toBe(0);
    expect(cap!.input_tokens).toBeGreaterThan(0);
    expect(cap!.output_tokens).toBeGreaterThan(0);
    expect(cap!.usage_missing).toBe(0);
  });

  test("OpenAI streaming with include_usage populates ttft_ms", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "umans-flash",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
        stream: true,
        stream_options: { include_usage: true },
      }),
    });
    expect(res.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of res.body ?? emptyAsync()) {
      // drain
    }
    const cap = await getLatestCapture("/v1/chat/completions");
    expect(cap).not.toBeNull();
    expect(cap!.provider).toBe("openai");
    expect(cap!.streaming).toBe(1);
    expect(cap!.ttft_ms).not.toBeNull();
    expect(cap!.usage_missing).toBe(0);
  });

  test("OpenAI streaming WITHOUT include_usage → usage_missing=true", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "umans-flash",
        messages: [{ role: "user", content: "Hello" }],
        max_tokens: 100,
        stream: true,
      }),
    });
    expect(res.ok).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    for await (const _chunk of res.body ?? emptyAsync()) {
      // drain
    }
    const cap = await getLatestCapture("/v1/chat/completions");
    expect(cap).not.toBeNull();
    expect(cap!.usage_missing).toBe(1);
    expect(cap!.output_tokens).toBeNull();
  });

  test("non-JSON 200 response → usage columns null", async () => {
    // Use a custom upstream that returns text/plain for this one call.
    // We'll hit the proxy with a path that the mock doesn't handle and
    // return a text body via the proxy's passthrough.
    // Actually, the mock-llm-upstream handles /v1/messages and /v1/chat/completions.
    // To test a non-JSON 200, we need a different upstream. Spin one up inline.
    const badUpstream = Bun.serve({
      port: 0,
      async fetch() {
        return new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
      },
    });
    const badProxy = await startInProcessProxy({
      target: `http://127.0.0.1:${badUpstream.port}`,
      warmerEnabled: false,
    });
    try {
      const res = await fetch(`${badProxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 100,
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
      await sleep(200);
      const rows = badProxy.db.list(5) as Array<{ id: number }>;
      const cap = rows[0];
      expect(cap).toBeDefined();
      const detail = badProxy.db.get(cap.id) as CaptureRow;
      expect(detail.model).toBeNull();
      expect(detail.input_tokens).toBeNull();
      expect(detail.output_tokens).toBeNull();
      expect(detail.usage_missing).toBeNull();
    } finally {
      await badProxy.kill();
      badUpstream.stop();
    }
  });

  test("HTTP 500 → usage columns null", async () => {
    const badUpstream = Bun.serve({
      port: 0,
      async fetch() {
        return new Response("Internal Server Error", { status: 500 });
      },
    });
    const badProxy = await startInProcessProxy({
      target: `http://127.0.0.1:${badUpstream.port}`,
      warmerEnabled: false,
    });
    try {
      const res = await fetch(`${badProxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          messages: [{ role: "user", content: "Hello" }],
          max_tokens: 100,
        }),
      });
      expect(res.status).toBe(500);
      await res.text();
      await sleep(200);
      const rows = badProxy.db.list(5) as Array<{ id: number }>;
      const cap = rows[0];
      expect(cap).toBeDefined();
      const detail = badProxy.db.get(cap.id) as CaptureRow;
      expect(detail.model).toBeNull();
      expect(detail.input_tokens).toBeNull();
      expect(detail.output_tokens).toBeNull();
      expect(detail.usage_missing).toBeNull();
    } finally {
      await badProxy.kill();
      badUpstream.stop();
    }
  });
});

async function* emptyAsync(): AsyncIterable<Uint8Array> {
  // No-op async iterator for when res.body is null.
}
