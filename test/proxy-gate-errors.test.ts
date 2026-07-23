// Characterization tests for handleProxy's gate-acquire and upstream-error
// response paths. These tests pin current behavior before the proxy handler
// is decomposed into smaller units.

import { expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Start a mock upstream that ALWAYS returns a 429 with retry-after: 3
 *  (classified as "concurrency" by classify429 → trips the circuit breaker). */
function startAlways429Upstream(): { port: number; close: () => Promise<void> } {
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

/** Start a mock upstream that delays response headers by `delayMs` so the
 *  client can abort before upstream responds (exercising the fetch-throw /
 *  499 path). Returns a normal streaming response once it does respond. */
function startSlowUpstream(delayMs: number): { port: number; close: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    async fetch() {
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

/** Start a mock upstream that streams slowly (200ms between chunks) and never
 *  closes — used to hold a concurrency slot open for the queue_full test. */
function startHoldingUpstream(): { port: number; close: () => Promise<void> } {
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

async function startProxyAndUpstream(
  upstreamPort: number,
  env: Record<string, string>,
): Promise<ProxyHandle> {
  return startProxy({
    TARGET: `http://127.0.0.1:${upstreamPort}`,
    ...env,
  });
}

test("breaker: one concurrency 429 with low threshold opens circuit → next request returns 503 circuit_open", async () => {
  const upstream = startAlways429Upstream();
  const proxy = await startProxyAndUpstream(upstream.port, {
    BREAKER_THRESHOLD: "1",
    BREAKER_WINDOW_MS: "300000",
    BREAKER_COOLDOWN_MS: "99999",
    CONCURRENCY_HARD_CAP: "10",
    CONCURRENCY_SOFT_LIMIT: "10",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
  });

  try {
    const r1 = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 10, messages: [] }),
    });
    expect(r1.status).toBe(429);

    const r2 = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 10, messages: [] }),
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

  const proxy = await startProxyAndUpstream(freePort, {
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
  });

  try {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 10, messages: [] }),
    });
    expect(res.status).toBe(502);
    expect(await res.text()).toContain("Bad Gateway");
  } finally {
    await proxy.kill();
  }
});

test("streaming request aborted mid-stream flushes capture with state done and status 499", async () => {
  // Use a slow upstream that delays response headers by 2s. The client aborts
  // at ~120ms while the upstream fetch is still pending → fetch throws
  // AbortError → handleProxy records status 499.
  const upstream = startSlowUpstream(2000);
  const proxy = await startProxyAndUpstream(upstream.port, {
    STAMP_CACHE_TTL_ENABLED: "false",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    RELEASE_COOLDOWN_MS: "0",
    CONCURRENCY_HARD_CAP: "1",
    CONCURRENCY_SOFT_LIMIT: "1",
  });

  try {
    const controller = new AbortController();
    const resPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      signal: controller.signal,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
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

    const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=20`);
    const captures = (await listRes.json()) as Array<{ id: number; path: string }>;
    const cap = captures.find((c) => c.path === "/v1/messages");
    expect(cap).toBeDefined();

    const detailRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures/${cap!.id}`);
    const detail = (await detailRes.json()) as {
      state: string;
      response_status: number | null;
    };
    expect(detail.state).toBe("done");
    expect(detail.response_status).toBe(499);
  } finally {
    await proxy.kill();
    upstream.close();
  }
});

test("queue_full: zero max queue depth with hard cap 1 rejects second concurrent streaming request", async () => {
  const upstream = startHoldingUpstream();
  const proxy = await startProxyAndUpstream(upstream.port, {
    MAX_QUEUE_DEPTH: "0",
    CONCURRENCY_HARD_CAP: "1",
    CONCURRENCY_SOFT_LIMIT: "1",
    RELEASE_COOLDOWN_MS: "0",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
  });

  try {
    const r1Promise = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4-5",
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
        model: "claude-sonnet-4-5",
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
