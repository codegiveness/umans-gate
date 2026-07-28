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
import { startProxy } from "../helpers/proxy.js";

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
  model: "umans-glm-5.2",
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

describe("TTFT retry success — incident row + ttft_ms reset", () => {
  test("success-after-retry records a ttft_timeout incident with proxy attribution", async () => {
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

      await sleep(300);

      // Incident row: every watchdog firing must be auditable with proxy
      // attribution, even when the retry succeeds (served_status=200).
      const incidentsRes = await fetch(
        `${proxy.baseUrl}/dashboard/api/incidents?incident_type=ttft_timeout`,
      );
      expect(incidentsRes.status).toBe(200);
      const incidents = (await incidentsRes.json()) as Array<{
        capture_id: number;
        responsible_party: string;
        incident_type: string;
        upstream_status: number | null;
        served_status: number;
        reason: string | null;
        retry_attempt: number | null;
        ttft_exceeded: number | null;
      }>;
      expect(incidents.length).toBe(1);
      expect(incidents[0].responsible_party).toBe("proxy");
      expect(incidents[0].incident_type).toBe("ttft_timeout");
      expect(incidents[0].upstream_status).toBe(null);
      expect(incidents[0].served_status).toBe(200);
      expect(incidents[0].retry_attempt).toBe(1);
      expect(incidents[0].ttft_exceeded).toBe(1);
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

describe("TTFT retry visibility — no auto-disable (compat shell)", () => {
  test("watchdog stays enabled after N consecutive retry failures — no disabled WS event", async () => {
    // Always-stall upstream: every call stalls, so every retry fails.
    // After ticket 01 the watchdog is a neutered compat shell: it never
    // auto-disables, so no gate WS event carries watchdog_disabled:true and
    // the REST endpoint reports watchdog_disabled:false.
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
      TTFT_WATCHDOG_HARD_CAP_MS: "200",
      TTFT_RETRY_COOLDOWN_MS: "0",
    });
    try {
      const gateEvents: Array<{ watchdog_disabled: boolean }> = [];

      const ws = new WebSocket(`ws://127.0.0.1:${proxy.port}/dashboard/ws`);

      const done = new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error("no-auto-disable WS test timeout"));
        }, 15000);

        ws.addEventListener("open", async () => {
          // Fire 3 sequential requests. Each stalls → retry fails.
          // The watchdog must stay armed after all three.
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

      // No gate event should report watchdog_disabled:true.
      const disabledEvent = gateEvents.find((e) => e.watchdog_disabled === true);
      expect(disabledEvent).toBeUndefined();

      // REST endpoint reports watchdog_disabled:false.
      const gateRes = await fetch(`${proxy.baseUrl}/dashboard/api/gate`);
      const gateStats = (await gateRes.json()) as { watchdog_disabled: boolean };
      expect(gateStats.watchdog_disabled).toBe(false);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});

describe("TTFT retry — ttft_ms excludes cooldown", () => {
  test("ttft_ms on a retried capture does not include the cooldown sleep", async () => {
    // Upstream stalls on call 1, emits an Anthropic-shaped SSE stream on
    // call 2 so extractUsage can compute ttft_ms from content_block_delta.
    let callCount = 0;
    const server = Bun.serve({
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
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            c.enqueue(
              new TextEncoder().encode(
                'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}\n\n',
              ),
            );
            c.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const upstream = {
      port: server.port!,
      getCallCount: () => callCount,
      close: () =>
        new Promise<void>((res) => {
          server.stop();
          setTimeout(res, 50);
        }),
    };

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
      TTFT_RETRY_COOLDOWN_MS: "300",
    });
    try {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-retry-attempt")).toBe("1");
      await res.text();
      expect(upstream.getCallCount()).toBe(2);

      // Wait for write-behind queue to flush (cooldown + retry + flush).
      await sleep(600);

      const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures`);
      const captures = (await listRes.json()) as Array<{
        id: number;
        ttft_ms: number | null;
        retry_attempt: number | null;
        ttft_exceeded: number | null;
      }>;
      const cap = captures.find((c) => c.retry_attempt === 1);
      expect(cap).toBeDefined();
      // TTFT timeout is 200ms; cooldown is 300ms. If the bug were present,
      // startedAt would be reset before cooldown, so ttft_ms would include
      // the 300ms cooldown sleep. With the fix, startedAt is reset after
      // cooldown, so ttft_ms reflects only the retry attempt's first-byte
      // latency — well under 300ms for this streaming upstream.
      expect(cap!.ttft_ms).not.toBeNull();
      expect(cap!.ttft_ms!).toBeLessThan(300);
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("/captures enriches with cooling_down state during active cooldown", async () => {
    // Stall on call 1 → TTFT watchdog fires → proxy enters cooldown.
    // While the cooldown is in flight, GET /captures should return
    // state=cooling_down with cooldownEndsAt populated (refresh-survival).
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
      TTFT_RETRY_COOLDOWN_MS: "2000", // long enough to poll during cooldown
    });
    try {
      // Fire the request but don't await it — it's still in flight during cooldown.
      const resPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
      });

      // Wait for TTFT watchdog to fire + cooldown to start.
      await sleep(400);

      const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures`);
      const captures = (await listRes.json()) as Array<{
        id: number;
        state: string;
        cooldownEndsAt?: number;
        retryAttempt?: number;
      }>;
      expect(captures.length).toBeGreaterThanOrEqual(1);
      const cap = captures[0];
      expect(cap.state).toBe("cooling_down");
      expect(cap.cooldownEndsAt).toBeDefined();
      expect(cap.cooldownEndsAt!).toBeGreaterThan(Date.now());
      expect(cap.retryAttempt).toBeGreaterThanOrEqual(1);

      // Detail endpoint should also be enriched.
      const detailRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures/${cap.id}`);
      const detail = (await detailRes.json()) as {
        state: string;
        cooldownEndsAt?: number;
      };
      expect(detail.state).toBe("cooling_down");
      expect(detail.cooldownEndsAt).toBeDefined();

      // Wait for the retry to complete so the proxy can shut down cleanly.
      await resPromise;
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });

  test("finally block clears cooldown entry on client abort during cooldown", async () => {
    // Stall on call 1 → TTFT watchdog fires → proxy enters cooldown.
    // Client aborts during the cooldown sleep. The finally block in
    // handleProxy must clear the in-flight cooldown entry so /captures
    // does not report cooling_down for an abandoned request.
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
      TTFT_RETRY_COOLDOWN_MS: "5000",
    });
    try {
      const controller = new AbortController();
      const resPromise = fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: MSG_HEADERS,
        body: MSG_BODY,
        signal: controller.signal,
      });

      // Wait for TTFT watchdog to fire + cooldown to start.
      await sleep(400);

      // Verify cooldown is active.
      const duringRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures`);
      const duringCaptures = (await duringRes.json()) as Array<{
        state: string;
        cooldownEndsAt?: number;
      }>;
      expect(duringCaptures[0].state).toBe("cooling_down");

      // Abort the client request during cooldown.
      controller.abort();
      try {
        await resPromise;
      } catch {
        // Expected — abort throws.
      }

      // Wait for the proxy to process the abort and run the finally block.
      await sleep(300);

      // The cooldown entry must be cleared — /captures should NOT report
      // cooling_down for this capture anymore.
      const afterRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures`);
      const afterCaptures = (await afterRes.json()) as Array<{
        state: string;
        cooldownEndsAt?: number;
      }>;
      expect(afterCaptures[0].state).not.toBe("cooling_down");
      expect(afterCaptures[0].cooldownEndsAt).toBeUndefined();
    } finally {
      await proxy.kill();
      await upstream.close();
    }
  });
});
