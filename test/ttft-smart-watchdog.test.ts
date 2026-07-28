// Ticket 03 — Integration tests for the dynamic TTFT threshold (attempt 1).
//
// The smart watchdog fetches /v1/status alongside the upstream request and
// recomputes the TTFT threshold from the model's p50 TTFT latency. Fast
// models get tight thresholds (stalls detected quickly); slow models get
// loose thresholds (legitimate requests not killed); status fetch failure
// falls back to the configured threshold.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

/** Mock upstream serving /v1/status + /v1/messages (stalling or streaming). */
function startSmartMock(opts: {
  modelP50: number;
  tpsP50?: number | null;
  overallP50?: number | null;
  stall?: boolean;
  statusFail?: boolean;
  statusDelayMs?: number;
  port?: number;
}): {
  port: number;
  close: () => Promise<void>;
  getStatusCount: () => number;
  getMessageCount: () => number;
} {
  let statusCount = 0;
  let msgCount = 0;
  const enc = new TextEncoder();
  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && url.pathname === "/v1/status") {
        statusCount++;
        if (opts.statusDelayMs) await Bun.sleep(opts.statusDelayMs);
        if (opts.statusFail) {
          return new Response("error", { status: 500 });
        }
        return Response.json({
          models: {
            "test-model": {
              p50_ttft_ms: opts.modelP50,
              p50_tps: opts.tpsP50 ?? null,
            },
          },
          overall:
            opts.overallP50 !== null && opts.overallP50 !== undefined
              ? { p50_ttft_ms: opts.overallP50 }
              : null,
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({
          object: "list",
          data: [{ id: "test-model", context_length: 128000 }],
        });
      }

      if (req.method === "GET" && url.pathname === "/v1/models/info") {
        return Response.json({});
      }

      if (req.method === "GET" && url.pathname === "/v1/usage") {
        return Response.json({
          plan: { display_name: "Test" },
          limits: { concurrency: { limit: 16, hard_cap: 16, burst_pct: 0 } },
          usage: {
            requests_in_window: 0,
            remaining_requests: null,
            concurrent_sessions: 0,
            tokens_in: 0,
            tokens_out: 0,
            tokens_cached: 0,
            priority: { low: false, boxed_until: null, reason: null },
            service_mode: { current: "normal", resets_at: null },
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        msgCount++;
        if (opts.stall) {
          const stall = new ReadableStream<Uint8Array>({
            start() {
              // never enqueue — simulates stuck connection
            },
          });
          return new Response(stall, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          });
        }
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(enc.encode("data: hello\n\n"));
            controller.close();
          },
        });
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      }

      return new Response("not found", { status: 404 });
    },
  });
  return {
    port: server.port!,
    getStatusCount: () => statusCount,
    getMessageCount: () => msgCount,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

const MODEL_BODY = JSON.stringify({
  model: "test-model",
  max_tokens: 100,
  messages: [{ role: "user", content: "hi" }],
  stream: true,
});

describe("Smart TTFT watchdog — dynamic threshold (attempt 1)", () => {
  describe("fast model (low p50) → tight threshold", () => {
    let upstream: ReturnType<typeof startSmartMock>;
    let proxy: ProxyHandle;

    beforeAll(async () => {
      upstream = startSmartMock({ modelP50: 2000, stall: true });
      proxy = await startProxy({
        TARGET: `http://127.0.0.1:${upstream.port}`,
        WARMER_ENABLED: "false",
        USAGE_REFRESH_MS: "999999",
        CONCURRENCY_HARD_CAP: "1",
        CONCURRENCY_SOFT_LIMIT: "1",
        RELEASE_COOLDOWN_MS: "0",
        EXPERIMENT_TTFT_WATCHDOG: "true",
        TTFT_TIMEOUT_MS: "60000",
        TTFT_WATCHDOG_MULTIPLIER: "5",
        TTFT_WATCHDOG_HARD_CAP_MS: "300000",
        UPSTREAM_TIMEOUT_MS: "1800000",
        TTFT_RETRY_MAX_ATTEMPTS: "1",
      });
    });

    afterAll(async () => {
      await proxy.kill();
      await upstream.close();
    });

    test("stalling request is killed quickly by tight threshold", async () => {
      const start = Date.now();
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test" },
        body: MODEL_BODY,
      });
      const elapsed = Date.now() - start;
      expect(res.status).toBe(504);
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBe("1");
      // Dynamic threshold = min(2000*5, 300000) = 10000ms.
      // Should fire well under the 60s fallback.
      expect(elapsed).toBeLessThan(15000);
      expect(elapsed).toBeGreaterThan(2000);
    }, 30000);
  });

  describe("slow model (high p50) → loose threshold", () => {
    let upstream: ReturnType<typeof startSmartMock>;
    let proxy: ProxyHandle;

    beforeAll(async () => {
      upstream = startSmartMock({ modelP50: 30000, stall: false });
      proxy = await startProxy({
        TARGET: `http://127.0.0.1:${upstream.port}`,
        WARMER_ENABLED: "false",
        USAGE_REFRESH_MS: "999999",
        CONCURRENCY_HARD_CAP: "1",
        CONCURRENCY_SOFT_LIMIT: "1",
        RELEASE_COOLDOWN_MS: "0",
        EXPERIMENT_TTFT_WATCHDOG: "true",
        TTFT_TIMEOUT_MS: "2000",
        TTFT_WATCHDOG_MULTIPLIER: "5",
        TTFT_WATCHDOG_HARD_CAP_MS: "300000",
        UPSTREAM_TIMEOUT_MS: "1800000",
        TTFT_RETRY_MAX_ATTEMPTS: "1",
      });
    });

    afterAll(async () => {
      await proxy.kill();
      await upstream.close();
    });

    test("legitimate request not killed by loose threshold", async () => {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test" },
        body: MODEL_BODY,
      });
      // Dynamic threshold = min(30000*5, 300000) = 150000ms.
      // The streaming response arrives immediately, so this should succeed.
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBeNull();
      const text = await res.text();
      expect(text).toContain("data: hello");
    }, 15000);
  });

  describe("status fetch fails → fallback threshold", () => {
    let upstream: ReturnType<typeof startSmartMock>;
    let proxy: ProxyHandle;

    beforeAll(async () => {
      upstream = startSmartMock({ modelP50: 2000, statusFail: true, stall: false });
      proxy = await startProxy({
        TARGET: `http://127.0.0.1:${upstream.port}`,
        WARMER_ENABLED: "false",
        USAGE_REFRESH_MS: "999999",
        CONCURRENCY_HARD_CAP: "1",
        CONCURRENCY_SOFT_LIMIT: "1",
        RELEASE_COOLDOWN_MS: "0",
        EXPERIMENT_TTFT_WATCHDOG: "true",
        TTFT_TIMEOUT_MS: "60000",
        TTFT_WATCHDOG_MULTIPLIER: "5",
        TTFT_WATCHDOG_HARD_CAP_MS: "300000",
        UPSTREAM_TIMEOUT_MS: "1800000",
        TTFT_RETRY_MAX_ATTEMPTS: "1",
      });
    });

    afterAll(async () => {
      await proxy.kill();
      await upstream.close();
    });

    test("request proceeds normally with fallback threshold", async () => {
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "test" },
        body: MODEL_BODY,
      });
      // Status fetch failed, so fallback threshold (60000ms) is used.
      // The streaming response arrives immediately, so this should succeed.
      expect(res.status).toBe(200);
      expect(res.headers.get("x-proxy-ttft-exceeded")).toBeNull();
      const text = await res.text();
      expect(text).toContain("data: hello");
      expect(upstream.getStatusCount()).toBeGreaterThanOrEqual(1);
    }, 15000);
  });
});
