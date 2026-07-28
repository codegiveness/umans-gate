// Integration tests for handleProxy error mitigation and gate-error paths.
// Merges the former proxy-error-mitigation.test.ts and proxy-gate-errors.test.ts
// into a single in-process suite. Each test spins up its own upstream(s) and
// proxy so concurrency/breaker state is isolated.

import { expect, test } from "bun:test";
import { startInProcessProxy } from "../helpers/in-process-proxy";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ─── Upstream helpers ────────────────────────────────────────────────────────

interface UpstreamHandle {
  port: number;
  close: () => Promise<void>;
}

function startNormalUpstream(): UpstreamHandle {
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

function startErrorUpstream(): UpstreamHandle {
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

function startSlowUpstream(delayMs: number): UpstreamHandle {
  const server = Bun.serve({
    port: 0,
    async fetch() {
      // Delay the entire fetch (including response headers) so a client abort
      // lands while the upstream fetch is still pending → fetch throws
      // AbortError → handleProxy records status 499.
      await sleep(delayMs);
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

/** Always returns 429 with retry-after: 3 (trips the circuit breaker). */
function startAlways429Upstream(): UpstreamHandle {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_exceeded" } }),
        {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "3" },
        },
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

/** Streams slowly (3s) and never closes — holds a concurrency slot open. */
function startHoldingUpstream(): UpstreamHandle {
  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            await sleep(3000);
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
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

// ─── Tests ───────────────────────────────────────────────────────────────────

test("proxy error responses are JSON, never HTML", async () => {
  const upstream = startNormalUpstream();
  const proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    stampClaudeCodeEnabled: false,
    warmerEnabled: false,
    releaseCooldownMs: 0,
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
  const proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    stampClaudeCodeEnabled: true,
    warmerEnabled: false,
    releaseCooldownMs: 0,
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
  const proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    stampClaudeCodeEnabled: false,
    warmerEnabled: false,
    releaseCooldownMs: 0,
    concurrencyHardCap: 1,
    concurrencySoftLimit: 1,
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
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      stampClaudeCodeEnabled: false,
      warmerEnabled: false,
      releaseCooldownMs: 0,
      concurrencyHardCap: 1,
      concurrencySoftLimit: 1,
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

test("breaker: one concurrency 429 with low threshold opens circuit → next request returns 503 circuit_open", async () => {
  const upstream = startAlways429Upstream();
  const proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    stampClaudeCodeEnabled: false,
    warmerEnabled: false,
    releaseCooldownMs: 0,
    concurrencyHardCap: 10,
    concurrencySoftLimit: 10,
    configOverrides: {
      breakerThreshold: 1,
      breakerWindowMs: 300000,
      breakerCooldownMs: 99999,
    },
  });

  try {
    const r1 = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "umans-glm-5.2", max_tokens: 10, messages: [] }),
    });
    expect(r1.status).toBe(429);

    const r2 = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "umans-glm-5.2", max_tokens: 10, messages: [] }),
    });
    expect(r2.status).toBe(503);
    const body2 = (await r2.json()) as { error?: string };
    expect(body2.error).toBe("circuit_open");
  } finally {
    await proxy.kill();
    upstream.close();
  }
});

test("dead upstream port returns 502 with Bad Gateway body", async () => {
  const freePort = await (async () => {
    const { createServer } = await import("node:net");
    return new Promise<number>((resolve, reject) => {
      const srv = createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        if (addr && typeof addr === "object") {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          reject(new Error("failed to find free port"));
        }
      });
      srv.on("error", reject);
    });
  })();

  const proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${freePort}`,
    stampClaudeCodeEnabled: false,
    warmerEnabled: false,
    releaseCooldownMs: 0,
  });

  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "umans-glm-5.2", max_tokens: 10, messages: [] }),
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("Bad Gateway");
  } finally {
    await proxy.kill();
  }
});

test("streaming request aborted mid-stream flushes capture with state done and status 499", async () => {
  const upstream = startSlowUpstream(2000);
  const proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    stampClaudeCodeEnabled: false,
    warmerEnabled: false,
    releaseCooldownMs: 0,
    concurrencyHardCap: 1,
    concurrencySoftLimit: 1,
  });

  try {
    const controller = new AbortController();
    const resPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "go" }],
      }),
    });

    // Abort before the upstream responds (upstream delays 2s).
    setTimeout(() => controller.abort(), 120);

    try {
      await resPromise;
    } catch {
      // fetch throws on abort — expected
    }

    // Give the proxy time to flush the capture row to the DB.
    await sleep(500);
    await proxy.queue.flushNow();

    const list = proxy.db.list(20);
    const cap = list.find((c) => c.path === "/v1/messages");
    expect(cap).toBeDefined();
    const detail = proxy.db.get(cap!.id);
    expect(detail).not.toBeNull();
    expect(detail!.state).toBe("done");
    expect(detail!.response_status).toBe(499);
  } finally {
    await proxy.kill();
    upstream.close();
  }
});

test("queue_full: zero max queue depth with hard cap 1 rejects second concurrent streaming request", async () => {
  const upstream = startHoldingUpstream();
  const proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    stampClaudeCodeEnabled: false,
    warmerEnabled: false,
    releaseCooldownMs: 0,
    concurrencyHardCap: 1,
    concurrencySoftLimit: 1,
    useHardCap: true,
    configOverrides: {
      maxQueueDepth: 0,
    },
  });

  try {
    const r1Promise = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 50,
        stream: true,
        messages: [{ role: "user", content: "go" }],
      }),
    });

    // Wait for r1 to acquire the single concurrency slot.
    await sleep(300);

    const r2 = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 50,
        stream: true,
        messages: [{ role: "user", content: "go" }],
      }),
    });

    expect(r2.status).toBe(503);
    const body = (await r2.json()) as { error?: string };
    expect(body.error).toBe("queue_full");

    // Clean up r1.
    try {
      const r1 = await r1Promise;
      await r1.text();
    } catch {
      // may have been aborted/killed
    }
  } finally {
    await proxy.kill();
    upstream.close();
  }
});
