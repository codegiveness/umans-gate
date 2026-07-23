// Ticket 01 — Persisted `retried` badge.
//
// After a TTFT-retried request completes, the capture row persists
// `retry_attempt` and `ttft_exceeded` columns. The dashboard REST API
// (`GET /dashboard/api/captures`) returns these fields so the `retried`
// badge survives a page refresh.
//
// A non-retried request returns `retry_attempt: 0` (or null) and
// `ttft_exceeded: 0` (or null).

import { describe, expect, test } from "bun:test";
import { startProxy } from "./helpers/proxy.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Upstream that stalls on the first N calls, then streams on call N+1.
 *  Only counts LLM-message POSTs. Copied from ttft-watchdog.test.ts. */
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

/** Upstream that emits one SSE chunk immediately, then closes. */
function startStreamingUpstream(): {
  port: number;
  close: () => Promise<void>;
} {
  const server = Bun.serve({
    port: 0,
    async fetch() {
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
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

const MSG_BODY = JSON.stringify({
  model: "claude-sonnet-4-5",
  max_tokens: 10,
  stream: true,
  messages: [{ role: "user", content: "test" }],
});
const MSG_HEADERS = { "content-type": "application/json" };

describe("TTFT retry visibility — persisted retry_attempt and ttft_exceeded", () => {
  test("retried request persists retry_attempt=1 and ttft_exceeded=1", async () => {
    // Stall on call 1, emit on call 2 → same-key retry succeeds.
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
      TTFT_RETRY_COOLDOWN_MS: "0",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("1");
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      await res.text();
      expect(upstream.getCallCount()).toBe(2);

      // Wait for write-behind queue to flush.
      await sleep(300);

      const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures`);
      const captures = (await listRes.json()) as Array<{
        retry_attempt: number | null;
        ttft_exceeded: number | null;
      }>;
      expect(captures.length).toBe(1);
      expect(captures[0].retry_attempt).toBe(1);
      expect(captures[0].ttft_exceeded).toBe(1);

      // Also verify the detail endpoint returns the fields (persists across
      // page refresh — the detail endpoint reads from the same row).
      const detailRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures/1`);
      const detail = (await detailRes.json()) as {
        retry_attempt: number | null;
        ttft_exceeded: number | null;
      };
      expect(detail.retry_attempt).toBe(1);
      expect(detail.ttft_exceeded).toBe(1);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("non-retried request persists retry_attempt=0 and ttft_exceeded=0", async () => {
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
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("0");
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBeNull();
      await res.text();

      await sleep(300);

      const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures`);
      const captures = (await listRes.json()) as Array<{
        retry_attempt: number | null;
        ttft_exceeded: number | null;
      }>;
      expect(captures.length).toBe(1);
      // Non-retried: retry_attempt is 0, ttft_exceeded is 0 (watchdog never fired).
      expect(captures[0].retry_attempt).toBe(0);
      expect(captures[0].ttft_exceeded).toBe(0);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

describe("TTFT retry visibility — in-flight cooldown + retry WS broadcasts", () => {
  test("broadcasts cooling_down then streaming with retryAttempt on TTFT retry", async () => {
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
      TTFT_RETRY_COOLDOWN_MS: "100",
    });
    try {
      const events: Array<{
        type: string;
        state?: string;
        retryAttempt?: number;
        cooldownEndsAt?: number;
        captureId?: number;
      }> = [];

      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/dashboard/ws`);

      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("WS broadcast test timeout"));
        }, 5000);

        ws.addEventListener("open", async () => {
          await fetch(`${proxy.baseUrl}/v1/messages`, {
            method: "POST",
            headers: MSG_HEADERS,
            body: MSG_BODY,
          });
          setTimeout(() => {
            clearTimeout(timeout);
            resolve();
          }, 800);
        });

        ws.addEventListener("message", (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === "state") {
            events.push({
              type: msg.type,
              state: msg.state,
              retryAttempt: msg.retryAttempt,
              cooldownEndsAt: msg.cooldownEndsAt,
              captureId: msg.captureId,
            });
          }
        });

        ws.addEventListener("error", (e) => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket error: ${e}`));
        });
      });

      await done;
      ws.close();

      const stateEvents = events.filter((e) => e.type === "state");
      const coolingDown = stateEvents.find(
        (e) => e.state === "cooling_down" && e.retryAttempt === 1,
      );
      const streamingRetry = stateEvents.find(
        (e) => e.state === "streaming" && e.retryAttempt === 1,
      );

      expect(coolingDown).toBeDefined();
      expect(coolingDown?.cooldownEndsAt).toBeDefined();
      const now = Date.now();
      expect(coolingDown!.cooldownEndsAt!).toBeGreaterThan(now - 2000);
      expect(coolingDown!.cooldownEndsAt!).toBeLessThan(now + 2000);

      expect(streamingRetry).toBeDefined();
      expect(streamingRetry?.retryAttempt).toBe(1);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

describe("TTFT retry visibility — auto-disable broadcasts watchdog_disabled via WS", () => {
  test("broadcasts gate WS with watchdog_disabled:true after N consecutive retry failures", async () => {
    // Always-stall upstream: every call stalls, so every retry fails.
    const upstream = startCountedStallUpstream(20);
    const proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
      CONCURRENCY_HARD_CAP: "4",
      CONCURRENCY_SOFT_LIMIT: "4",
      RELEASE_COOLDOWN_MS: "0",
      UPSTREAM_TIMEOUT_MS: "5000",
      EXPERIMENT_TTFT_WATCHDOG: "true",
      TTFT_TIMEOUT_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
      TTFT_RETRY_FAILURE_THRESHOLD: "3",
      TTFT_RETRY_FAILURE_WINDOW_MS: "300000",
    });
    try {
      const gateEvents: Array<{ watchdog_disabled: boolean }> = [];

      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/dashboard/ws`);

      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("auto-disable WS test timeout"));
        }, 15000);

        ws.addEventListener("open", async () => {
          // Fire 3 sequential requests. Each stalls → retry fails →
          // recordRetryOutcome(false). After the 3rd, watchdog auto-disables.
          for (let i = 0; i < 3; i++) {
            try {
              await fetch(`${proxy.baseUrl}/v1/messages`, {
                method: "POST",
                headers: MSG_HEADERS,
                body: MSG_BODY,
              });
            } catch {
              // 504 responses are expected
            }
          }
          // Give the WS broadcast time to arrive.
          setTimeout(() => {
            clearTimeout(timeout);
            resolve();
          }, 1000);
        });

        ws.addEventListener("message", (e) => {
          const msg = JSON.parse(e.data);
          if (msg.type === "gate") {
            gateEvents.push({
              watchdog_disabled: msg.stats?.watchdog_disabled ?? false,
            });
          }
        });

        ws.addEventListener("error", (e) => {
          clearTimeout(timeout);
          reject(new Error(`WebSocket error: ${e}`));
        });
      });

      await done;
      ws.close();

      const disabledEvent = gateEvents.find((e) => e.watchdog_disabled === true);
      expect(disabledEvent).toBeDefined();

      // Also verify the REST endpoint returns watchdog_disabled: true.
      const gateRes = await fetch(`${proxy.baseUrl}/dashboard/api/gate`);
      const gateStats = (await gateRes.json()) as { watchdog_disabled: boolean };
      expect(gateStats.watchdog_disabled).toBe(true);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});
