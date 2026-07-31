// Ticket 02 — TTFT watchdog "detect and fail" path.
//
// When experiment_ttft_watchdog is ON and the upstream stalls on the first
// byte, the proxy detects it, aborts the fetch, and returns 504 with
// X-Proxy-TTFT-Exceeded: 1.
//
// When the feature is OFF, behavior is unchanged.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pollUntil } from "../helpers/poll-until.js";
import { type ProxyHandle, startProxy } from "../helpers/proxy.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForGateActive(proxy: ProxyHandle, expected: number): Promise<void> {
  await pollUntil(async () => {
    const active = await getGateActive(proxy);
    return active === expected;
  });
}

async function waitForUpstreamCalls(
  upstream: { getCallCount(): number },
  expected: number,
): Promise<void> {
  await pollUntil(() => upstream.getCallCount() >= expected);
}

async function waitForTtftIncident(proxy: ProxyHandle, expectedCount: number): Promise<void> {
  await pollUntil(async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/incidents`);
    const incidents = (await res.json()) as Array<{ incident_type: string }>;
    return incidents.filter((i) => i.incident_type === "ttft_timeout").length >= expectedCount;
  });
}

/** Upstream that returns 200 + a ReadableStream that NEVER enqueues — simulates
 *  a stuck-on-first-byte connection. Only counts LLM-message POSTs. */
function startStallingUpstream(): {
  port: number;
  close: () => Promise<void>;
  getCallCount: () => number;
} {
  let callCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method === "POST" && new URL(req.url).pathname === "/v1/messages") {
        callCount++;
      }
      const stall = new ReadableStream<Uint8Array>({
        start() {
          // never enqueue — simulates stuck connection
        },
      });
      return new Response(stall, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    port: server.port!,
    getCallCount: () => callCount,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

/** Upstream that emits one SSE chunk immediately, then closes. */
function startStreamingUpstream(): {
  port: number;
  close: () => Promise<void>;
  getCallCount: () => number;
} {
  let callCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      callCount++;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("data: hello\n\n"));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  return {
    port: server.port!,
    getCallCount: () => callCount,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

/** Upstream that returns 200 with an empty body (no stream). */
function startEmptyBodyUpstream(): {
  port: number;
  close: () => Promise<void>;
  getCallCount: () => number;
} {
  let callCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      callCount++;
      return new Response(null, { status: 200 });
    },
  });
  return {
    port: server.port!,
    getCallCount: () => callCount,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

async function getGateActive(proxy: ProxyHandle): Promise<number> {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/gate`);
  const stats = (await res.json()) as { active: number };
  return stats.active;
}

describe("TTFT watchdog — feature off by default", () => {
  let upstream: ReturnType<typeof startStallingUpstream>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    upstream = startStallingUpstream();
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "1",
      CONCURRENCY_SOFT_LIMIT: "1",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "500",
      EXPERIMENT_TTFT_WATCHDOG: "false",
    });
  });

  afterAll(async () => {
    await proxy.kill();
    await upstream.close();
  });

  test("stalling upstream produces 504 via absolute timeout, no X-Proxy-TTFT-Exceeded header", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "test" }],
      }),
    });
    expect(res.status).toBe(504);
    expect(res.headers.get("x-proxy-ttft-exceeded")).toBeNull();
    await res.text();
  });
});

describe("TTFT watchdog — feature ON, TTFT timeout", () => {
  let upstream: ReturnType<typeof startStallingUpstream>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    upstream = startStallingUpstream();
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "1",
      CONCURRENCY_SOFT_LIMIT: "1",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
    });
  });

  afterAll(async () => {
    await proxy.kill();
    await upstream.close();
  });

  test("TTFT timeout returns 504 with X-Proxy-TTFT-Exceeded: 1", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "test" }],
      }),
    });
    expect(res.status).toBe(504);
    expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
    await res.text();
  });

  test("permit released after TTFT timeout — next request proceeds immediately", async () => {
    // First request stalls and TTFT-times-out (~200ms)
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
    expect(r1.status).toBe(504);
    await r1.text();

    // Give the finally block a moment to release the permit
    await waitForGateActive(proxy, 0);
    const active = await getGateActive(proxy);
    expect(active).toBe(0);
  });
});

describe("TTFT watchdog — client abort during TTFT race", () => {
  let upstream: ReturnType<typeof startStallingUpstream>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    upstream = startStallingUpstream();
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "1",
      CONCURRENCY_SOFT_LIMIT: "1",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "10000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "1000",
    });
  });

  afterAll(async () => {
    await proxy.kill();
    await upstream.close();
  });

  test("client abort during TTFT race — no retry, single fetch", async () => {
    const controller = new AbortController();
    const reqPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "abort me" }],
      }),
      signal: controller.signal,
    });
    // Abort before the TTFT timeout (1000ms) fires
    await sleep(50);
    controller.abort();
    try {
      await reqPromise;
    } catch {
      // expected — abort throws
    }
    // Give the proxy a moment to settle
    await waitForUpstreamCalls(upstream, 1);
    // No retry: only one upstream fetch happened
    expect(upstream.getCallCount()).toBe(1);
  });
});

describe("TTFT watchdog — client abort during cooldown between retries", () => {
  test("client abort during cooldown → 499, no second fetch", async () => {
    // Stalls on every fetch — TTFT will fire on attempt 1, then cooldown
    // starts, and we abort during cooldown.
    const upstream = startStallingUpstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "10000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "500",
      TTFT_RETRY_MAX_ATTEMPTS: "2",
    });
    try {
      const controller = new AbortController();
      const reqPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "abort in cooldown" }],
        }),
        signal: controller.signal,
      });
      // Wait for TTFT to fire (200ms), then abort during cooldown (500ms).
      await sleep(350);
      controller.abort();
      try {
        await reqPromise;
      } catch {
        // expected — abort throws
      }
      await waitForUpstreamCalls(upstream, 1);
      // Only one fetch happened — the cooldown was interrupted before attempt 2.
      expect(upstream.getCallCount()).toBe(1);
      // Permit released (gate active = 0).
      await waitForGateActive(proxy, 0);
      expect(await getGateActive(proxy)).toBe(0);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

describe("TTFT watchdog — first chunk arrives in time", () => {
  let upstream: ReturnType<typeof startStreamingUpstream>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    upstream = startStreamingUpstream();
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "1",
      CONCURRENCY_SOFT_LIMIT: "1",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "1000",
    });
  });

  afterAll(async () => {
    await proxy.kill();
    await upstream.close();
  });

  test("first chunk arrives — normal streaming, first chunk NOT lost from response", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-proxy-ttft-exceeded")).toBeNull();
    const body = await res.text();
    expect(body).toContain("data: hello");
  });
});

describe("TTFT watchdog — empty body (done:true on first read)", () => {
  let upstream: ReturnType<typeof startEmptyBodyUpstream>;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    upstream = startEmptyBodyUpstream();
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "1",
      CONCURRENCY_SOFT_LIMIT: "1",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "1000",
    });
  });

  afterAll(async () => {
    await proxy.kill();
    await upstream.close();
  });

  test("empty body returns 200, no TTFT-exceeded header", async () => {
    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "empty" }],
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("x-proxy-ttft-exceeded")).toBeNull();
    await res.text();
  });
});

// ─── Ticket 03: same-key retry + response headers ─────────────────────────

describe("TTFT watchdog — ticket 03 same-key retry", () => {
  test("retry happens — fetch count is 2, x-proxy-retry-attempt: 1", async () => {
    let callCount = 0;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") {
          return new Response("not found", { status: 404 });
        }
        callCount++;
        if (callCount === 1) {
          return new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: hello\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "retry me" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("1");
      await res.text();
      expect(callCount).toBe(2);
    } finally {
      await proxy.kill();
      upstream.stop();
      await sleep(50);
    }
  });

  test("x-proxy-retry-attempt is 0 on no-retry success", async () => {
    const upstream = startStreamingUpstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "1000",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("0");
      await res.text();
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("x-proxy-ttft-exceeded present when watchdog fired (even on successful retry)", async () => {
    let callCount = 0;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") {
          return new Response("not found", { status: 404 });
        }
        callCount++;
        if (callCount === 1) {
          return new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: hello\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "retry me" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await res.text();
    } finally {
      await proxy.kill();
      upstream.stop();
      await sleep(50);
    }
  });

  test("x-proxy-breaker-state reflects current state (closed)", async () => {
    const upstream = startStreamingUpstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "1000",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "hello" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-breaker-state")).toBe("closed");
      // Cross-check against the dashboard /gate endpoint (no token in tests).
      const gateRes = await fetch(`${proxy.baseUrl}/dashboard/api/gate`);
      const gateStats = (await gateRes.json()) as { breaker: string };
      expect(gateStats.breaker).toBe("closed");
      expect(res.headers.get("x-proxy-breaker-state")).toBe(gateStats.breaker);
      await res.text();
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("rate limiter charged once not twice — retry not rejected with 429", async () => {
    let callCount = 0;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") {
          return new Response("not found", { status: 404 });
        }
        callCount++;
        if (callCount === 1) {
          return new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: hello\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      RATE_LIMIT_REQUESTS: "1",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "retry me" }],
        }),
      });
      // If the retry were charged a second token, it would get 429.
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("1");
      await res.text();
      expect(callCount).toBe(2);
    } finally {
      await proxy.kill();
      upstream.stop();
      await sleep(50);
    }
  });

  test("breaker state unchanged after TTFT timeout", async () => {
    // Stalling upstream + cap reached → no retry, 504. Breaker must stay closed.
    const upstream = startStallingUpstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "1",
    });
    try {
      // First request: TTFT timeout, no retry (cap=1), returns 504.
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
      expect(r1.status).toBe(504);
      expect(r1.headers.get("x-proxy-breaker-state")).toBe("closed");
      await r1.text();

      // Second request: also stalling, but the breaker must still be closed
      // (TTFT timeouts do not trip the breaker).
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
      expect(r2.headers.get("x-proxy-breaker-state")).toBe("closed");
      await r2.text();
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("retry suppressed when gate saturated — x-proxy-retry-attempt: 0", async () => {
    // TTFT_RETRY_GATE_SATURATION_PCT=0 → any active count >= 0% of softLimit
    // suppresses retry. With one in-flight request, retry is always suppressed.
    const upstream = startStallingUpstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_GATE_SATURATION_PCT: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "saturate" }],
        }),
      });
      expect(res.status).toBe(504);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("0");
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await res.text();
      // Only the original fetch happened — no retry.
      expect(upstream.getCallCount()).toBe(1);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("retry suppressed when cap reached — 504, x-proxy-retry-attempt: 0", async () => {
    // TTFT_RETRY_MAX_ATTEMPTS=1 → original only, no retry.
    const upstream = startStallingUpstream();
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "1",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "capped" }],
        }),
      });
      expect(res.status).toBe(504);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("0");
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await res.text();
      expect(upstream.getCallCount()).toBe(1);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("permit released after retry succeeds — gateActive returns to 0", async () => {
    let callCount = 0;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") {
          return new Response("not found", { status: 404 });
        }
        callCount++;
        if (callCount === 1) {
          return new Response(new ReadableStream({ start() {} }), {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: hello\n\n"));
              c.close();
            },
          }),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "retry me" }],
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
      // Give the TransformStream flush + releasePermit a moment to settle.
      await waitForGateActive(proxy, 0);
      const active = await getGateActive(proxy);
      expect(active).toBe(0);
    } finally {
      await proxy.kill();
      upstream.stop();
      await sleep(50);
    }
  });
});

// ─── Ticket 01: watchdog never auto-disables (compat shell) ──────────────

describe("TTFT watchdog — ticket 01 no auto-disable", () => {
  test("watchdog stays armed after consecutive retry failures — 3rd request still retries", async () => {
    // Upstream ALWAYS stalls (never enqueues) — both fetch 1 and fetch 2 of
    // each request fail. Previously threshold=2 would auto-disable on the 2nd
    // request. After ticket 01 the watchdog is a neutered compat shell: it
    // never auto-disables, so the 3rd request retries exactly like the first two.
    let callCount = 0;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") {
          return new Response("not found", { status: 404 });
        }
        callCount++;
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "1000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "2",
    });
    try {
      const body = JSON.stringify({
        model: "umans-glm-5.2",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "stall" }],
      });
      const headers = { "content-type": "application/json" };

      // Request 1: original stalls → retry → retry stalls → 504.
      const r1 = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body,
      });
      expect(r1.status).toBe(504);
      expect(r1.headers.get("x-proxy-retry-attempt")).toBe("1");
      expect(r1.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await r1.text();
      await waitForGateActive(proxy, 0);

      // Request 2: same pattern. Watchdog still armed (no auto-disable).
      const r2 = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body,
      });
      expect(r2.status).toBe(504);
      expect(r2.headers.get("x-proxy-retry-attempt")).toBe("1");
      await r2.text();
      await waitForGateActive(proxy, 0);

      // Request 3: watchdog still armed → retry happens → 2 upstream fetches.
      const callsBeforeR3 = callCount;
      const r3 = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers,
        body,
      });
      expect(r3.status).toBe(504);
      expect(r3.headers.get("x-proxy-retry-attempt")).toBe("1");
      expect(r3.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await r3.text();
      // Exactly TWO upstream fetches for request 3 (original + retry).
      expect(callCount - callsBeforeR3).toBe(2);
    } finally {
      await proxy.kill();
      upstream.stop();
      await sleep(50);
    }
  });
});

// ─── Ticket 05: rewrite-id escalation (attempt 3) ──────────────────────────

const OPENCODE_UA = "opencode/1.18.2 ai-sdk/provider-utils/4.0.27 runtime/bun/1.3.14";
const SESSION_ID = "ses_094245ee8ffeE1vAORqPmsfxAI";

/** Upstream that stalls on calls 1-N, then emits on call N+1.
 *  Only counts LLM-message POSTs. */
function startCountedStallUpstream(stallCount: number): {
  port: number;
  close: () => Promise<void>;
  getCallCount: () => number;
} {
  let callCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") {
        return new Response("not found", { status: 404 });
      }
      callCount++;
      if (callCount <= stallCount) {
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("data: hello\n\n"));
            c.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  return {
    port: server.port!,
    getCallCount: () => callCount,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

describe("TTFT watchdog — ticket 05 rewrite-id escalation", () => {
  test("rewrite escalation on second timeout when eligible — 504, fetch count 3", async () => {
    // Mock stalls on fetch 1, 2, AND 3 — all three stall.
    const upstream = startCountedStallUpstream(3);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      EXPERIMENT_REWRITE_IDS: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "3",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OPENCODE_UA,
          "x-session-id": SESSION_ID,
        },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "escalate" }],
        }),
      });
      expect(res.status).toBe(504);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("2");
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await res.text();
      // All three attempts happened (original + same-key retry + rewrite).
      expect(upstream.getCallCount()).toBe(3);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("rewrite escalation succeeds — fetch 3 emits, 200, x-proxy-retry-attempt: 2", async () => {
    // Mock stalls on fetch 1 and 2, emits on fetch 3.
    const upstream = startCountedStallUpstream(2);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      EXPERIMENT_REWRITE_IDS: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "3",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OPENCODE_UA,
          "x-session-id": SESSION_ID,
        },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "recover" }],
        }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("2");
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      const body = await res.text();
      expect(body).toContain("data: hello");
      expect(upstream.getCallCount()).toBe(3);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("504 when ineligible (no session-id) and both attempts stall — fetch count 2", async () => {
    // Mock stalls on fetch 1 and 2. NO x-session-id header → not rewrite-eligible.
    const upstream = startCountedStallUpstream(2);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      EXPERIMENT_REWRITE_IDS: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "3",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OPENCODE_UA,
          // NO x-session-id header → not rewrite-eligible
        },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "no-session" }],
        }),
      });
      expect(res.status).toBe(504);
      // Only same-key retry happened (retryAttempt=1), no rewrite escalation.
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("1");
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await res.text();
      // Only two fetches (original + same-key retry), no attempt 3.
      expect(upstream.getCallCount()).toBe(2);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("rewrite escalation not attempted when max_attempts < 3 — fetch count 2, 504", async () => {
    // Same as test 1 but TTFT_RETRY_MAX_ATTEMPTS=2 → no attempt 3.
    const upstream = startCountedStallUpstream(2);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      EXPERIMENT_REWRITE_IDS: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "2",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OPENCODE_UA,
          "x-session-id": SESSION_ID,
        },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "capped" }],
        }),
      });
      expect(res.status).toBe(504);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("1");
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await res.text();
      // Only two fetches — no attempt 3.
      expect(upstream.getCallCount()).toBe(2);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("existing 502/529 rewrite-id path unchanged — passes neither optional param", async () => {
    // Mock upstream returns 502 with overloaded_error on first call, 200 on second.
    let callCount = 0;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") {
          return new Response("not found", { status: 404 });
        }
        callCount++;
        if (callCount === 1) {
          return new Response(
            JSON.stringify({ type: "error", error: { type: "overloaded_error" } }),
            { status: 502, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "false",
      EXPERIMENT_REWRITE_IDS: "true",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OPENCODE_UA,
          "x-session-id": SESSION_ID,
        },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "fifty-two" }],
        }),
      });
      // Existing 502/529 path triggers rewrite retry → second fetch returns 200.
      expect(res.status).toBe(200);
      expect(callCount).toBe(2);
      // No TTFT headers (watchdog off).
      expect(res.headers.get("x-proxy-retry-attempt")).toBeNull();
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBeNull();
      await res.text();
    } finally {
      await proxy.kill();
      upstream.stop();
      await sleep(50);
    }
  });
});

describe("TTFT watchdog — client abort during rewrite-escalation fetch", () => {
  test("client abort on attempt 3 returns 499, does NOT count toward auto-disable", async () => {
    // Stalls on fetches 1-5; streams on fetch 6+.
    // Request 1: fetches 1-3 (attempts 1-3 stall, client aborts on attempt 3).
    // Request 2: fetches 4-5 stall (attempts 1-2 TTFT-timeout), fetch 6 streams (attempt 3 rewrite succeeds).
    // After ticket 01 the watchdog never auto-disables (neutered compat shell),
    // so request 2 retries regardless of prior outcomes.
    const upstream = startCountedStallUpstream(5);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      EXPERIMENT_REWRITE_IDS: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "3",
    });
    try {
      // --- Request 1: abort during attempt 3 ---
      const controller = new AbortController();
      const reqPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OPENCODE_UA,
          "x-session-id": SESSION_ID,
        },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "abort attempt 3" }],
        }),
        signal: controller.signal,
      });
      // Wait for attempts 1+2 to TTFT-timeout (2 × 200ms = 400ms),
      // then abort during attempt 3's stalling fetch.
      await sleep(550);
      controller.abort();
      try {
        await reqPromise;
      } catch {
        // expected — abort throws
      }
      await waitForUpstreamCalls(upstream, 3);
      // All 3 fetches happened (2 TTFT-timeouts + 1 client abort).
      expect(upstream.getCallCount()).toBe(3);

      // --- Request 2: verify feature NOT auto-disabled ---
      // If auto-disabled (bug): watchdog disarmed → fetch 4 stalls → absolute timeout (5000ms) → 504.
      // If correct: watchdog armed → fetches 4-5 TTFT-timeout → fetch 6 streams → 200.
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OPENCODE_UA,
          "x-session-id": SESSION_ID,
        },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "verify not disabled" }],
        }),
      });
      // Feature still armed (not auto-disabled) → retries happened → 200.
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("2");
      await res.text();
      // 6 total fetches: 3 from request 1 + 3 from request 2 (attempts 1-3).
      expect(upstream.getCallCount()).toBe(6);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

// ─── Ticket 04: two-tier threshold + rewrite decoupling + incident consolidation ─

describe("TTFT watchdog — ticket 04 two-tier threshold", () => {
  test("attempts 2+ use effective_hard_cap, not ttft_timeout_ms", async () => {
    let callCount = 0;
    const upstream = Bun.serve({
      port: 0,
      async fetch(req) {
        if (req.method !== "POST" || new URL(req.url).pathname !== "/v1/messages") {
          return new Response("not found", { status: 404 });
        }
        callCount++;
        return new Response(new ReadableStream({ start() {} }), {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "400",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "2",
    });
    try {
      const start = Date.now();
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "two-tier" }],
        }),
      });
      const elapsed = Date.now() - start;
      expect(res.status).toBe(504);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("1");
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await res.text();
      expect(elapsed).toBeGreaterThanOrEqual(550);
      expect(callCount).toBe(2);
    } finally {
      await proxy.kill();
      upstream.stop();
      await sleep(50);
    }
  });
});

describe("TTFT watchdog — ticket 04 rewrite decoupling", () => {
  test("attempt 3 rewrite fires with experiment_rewrite_ids OFF", async () => {
    const upstream = startCountedStallUpstream(3);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "3",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OPENCODE_UA,
          "x-session-id": SESSION_ID,
        },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "decoupled" }],
        }),
      });
      expect(res.status).toBe(504);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("2");
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await res.text();
      expect(upstream.getCallCount()).toBe(3);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

describe("TTFT watchdog — ticket 04 per-attempt incidents", () => {
  test("3 attempts exhausted → one ttft_timeout incident per attempt", async () => {
    const upstream = startCountedStallUpstream(3);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      EXPERIMENT_REWRITE_IDS: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_MAX_ATTEMPTS: "3",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": OPENCODE_UA,
          "x-session-id": SESSION_ID,
        },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "single-incident" }],
        }),
      });
      expect(res.status).toBe(504);
      await res.text();
      await waitForTtftIncident(proxy, 3);

      const incidentsRes = await fetch(`${proxy.baseUrl}/dashboard/api/incidents`);
      const incidents = (await incidentsRes.json()) as Array<{
        capture_id: number;
        incident_type: string;
        reason: string | null;
        retry_attempt: number | null;
      }>;
      const ttftIncidents = incidents.filter((i) => i.incident_type === "ttft_timeout");
      expect(ttftIncidents.length).toBe(3);
      expect(ttftIncidents.every((i) => i.reason?.includes("TTFT timeout attempt"))).toBe(true);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("retry succeeds → attempt-1 timeout incident recorded (200 served, but timeout happened)", async () => {
    const upstream = startCountedStallUpstream(1);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "umans-glm-5.2",
          max_tokens: 10,
          stream: true,
          messages: [{ role: "user", content: "success-incident" }],
        }),
      });
      expect(res.status).toBe(200);
      await res.text();
      await waitForTtftIncident(proxy, 1);

      const incidentsRes = await fetch(`${proxy.baseUrl}/dashboard/api/incidents`);
      const incidents = (await incidentsRes.json()) as Array<{
        capture_id: number;
        incident_type: string;
        reason: string | null;
      }>;
      const ttftIncidents = incidents.filter((i) => i.incident_type === "ttft_timeout");
      expect(ttftIncidents.length).toBe(1);
      expect(ttftIncidents[0].reason).toContain("TTFT timeout attempt 1");
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

describe("TTFT watchdog — ticket 04 WS threshold broadcast", () => {
  test("cooling_down WS state includes threshold value", async () => {
    const upstream = startCountedStallUpstream(1);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "2",
      CONCURRENCY_SOFT_LIMIT: "2",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "2000",
    });
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/dashboard/ws`);
      const stateMsgs: Array<{ threshold?: number | null }> = [];

      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("WS threshold test timeout")), 10000);
        ws.addEventListener("open", async () => {
          try {
            await fetch(`${proxy.baseUrl}/v1/messages`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                model: "umans-glm-5.2",
                max_tokens: 10,
                stream: true,
                messages: [{ role: "user", content: "threshold-ws" }],
              }),
            });
          } catch {
            // expected
          }
          setTimeout(() => {
            clearTimeout(timeout);
            resolve();
          }, 500);
        });
        ws.addEventListener("message", (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === "state" && msg.state === "cooling_down") {
            stateMsgs.push({ threshold: msg.threshold });
          }
        });
        ws.addEventListener("error", (e) => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket error: ${e}`));
        });
      });

      await done;
      ws.close();
      expect(stateMsgs.length).toBeGreaterThanOrEqual(1);
      expect(stateMsgs[0].threshold).not.toBeNull();
      expect(stateMsgs[0].threshold).toBeGreaterThan(0);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});
