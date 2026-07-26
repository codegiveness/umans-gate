import { expect, test } from "bun:test";
import { startProxy } from "./helpers/proxy.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function startNormalUpstream(): { port: number; close: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"type":"message_start"}\n\n'));
            controller.enqueue(enc.encode('data: {"type":"message_stop"}\n\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    },
  });
  return {
    port: server.port!,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

function startErrorUpstream(): { port: number; close: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response("upstream error", { status: 500 });
    },
  });
  return {
    port: server.port!,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

function startSlowUpstream(delayMs: number): { port: number; close: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(enc.encode('data: {"type":"message_start"}\n\n'));
            await Bun.sleep(delayMs);
            controller.enqueue(enc.encode('data: {"type":"message_stop"}\n\n'));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
      );
    },
  });
  return {
    port: server.port!,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

test("proxy error responses are JSON, never HTML", async () => {
  const upstream = startNormalUpstream();
  const proxy = await startProxy({
    TARGET: `http://127.0.0.1:${upstream.port}`,
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    STAMP_CACHE_TTL_ENABLED: "false",
  });

  try {
    const r1 = await fetch(`${proxy.baseUrl}/nonexistent`, { method: "GET" });
    expect(r1.status).toBe(404);
    expect(r1.headers.get("content-type")).toBe("application/json");
    const body1 = await r1.json();
    expect(body1.error).toBe("not_an_llm_endpoint");
    const text1 = JSON.stringify(body1);
    expect(text1).not.toContain("<!doctype");
    expect(text1).not.toContain("<html");

    const r2 = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "umans-glm-5.2", max_tokens: 10, messages: [] }),
    });
    expect(r2.status).toBe(200);
    await r2.text();
  } finally {
    await proxy.kill();
    upstream.close();
  }
});

test("stamp pipeline succeeds with valid Anthropic body and cache_control", async () => {
  const upstream = startNormalUpstream();
  const proxy = await startProxy({
    TARGET: `http://127.0.0.1:${upstream.port}`,
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    STAMP_CACHE_TTL_ENABLED: "true",
  });

  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "test" }],
        system: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await res.text();
  } finally {
    await proxy.kill();
    upstream.close();
  }
});

test("permit is released after upstream 500 — next request succeeds immediately", async () => {
  const upstream = startErrorUpstream();
  const proxy = await startProxy({
    TARGET: `http://127.0.0.1:${upstream.port}`,
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    STAMP_CACHE_TTL_ENABLED: "false",
    CONCURRENCY_HARD_CAP: "1",
    CONCURRENCY_SOFT_LIMIT: "1",
    RELEASE_COOLDOWN_MS: "0",
  });

  try {
    const r1 = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "first" }],
      }),
    });
    expect(r1.status).toBe(500);
    await r1.text();

    await sleep(50);

    const start = Date.now();
    const r2 = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "second" }],
      }),
    });
    const elapsed = Date.now() - start;
    expect(r2.status).toBe(500);
    expect(elapsed).toBeLessThan(5000);
    await r2.text();
  } finally {
    await proxy.kill();
    upstream.close();
  }
});

test(
  "mid-stream client abort does not hang the proxy — next request succeeds",
  async () => {
    const upstream = startSlowUpstream(2000);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      STAMP_CACHE_TTL_ENABLED: "false",
      CONCURRENCY_HARD_CAP: "1",
      CONCURRENCY_SOFT_LIMIT: "1",
      RELEASE_COOLDOWN_MS: "0",
    });

    try {
      const controller = new AbortController();
      const resPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        signal: controller.signal,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "first" }],
        }),
      });

      await sleep(200);
      controller.abort();

      try {
        const res = await resPromise;
        if (res) await res.text().catch(() => {});
      } catch {
        // expected — abort throws on client side
      }

      await sleep(300);

      // Regression: assert the concurrency gate fully drained the permit after
      // the client aborted mid-stream. A leak would leave active=1 with cap 1.
      const metricsRes = await fetch(`${proxy.baseUrl}/metrics`);
      const metricsBody = await metricsRes.text();
      const activeMatch = metricsBody.match(/umans_gate_gate_active\s+(\d+)/);
      expect(activeMatch).not.toBeNull();
      expect(Number(activeMatch![1])).toBe(0);

      const r2 = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "second" }],
        }),
      });
      expect(r2.status).toBe(200);
      await r2.text();
    } finally {
      await proxy.kill();
      upstream.close();
    }
  },
  { timeout: 15000 },
);
