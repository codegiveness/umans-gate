// Test: W2 — onTraffic must fire AFTER gate acquire, not at handleProxy entry.
// The warmer's notifyTraffic() (passed as onTraffic) sets lastTrafficAt, which
// makes the warmer skip its next ping. If onTraffic fires before the gate
// check, a gate-rejected request (circuit_open / queue_full / timeout) still
// marks traffic — so the warmer wrongly skips, even though no upstream request
// occurred. This test pins the contract: onTraffic fires only when a permit
// is actually acquired.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { CaptureDB } from "../../src/db.js";
import { ConcurrencyGate } from "../../src/limiter/index.js";
import type { ModelsClient } from "../../src/models.js";
import { createProxyHandler, type RateLimiterRef } from "../../src/proxy.js";
import type { WriteQueue } from "../../src/queue.js";
import type { UsageSnapshot } from "../../src/types.js";
import type { VisionHandoff } from "../../src/vision/handoff.js";
import type { WsBroadcaster } from "../../src/ws.js";

const failSnap: UsageSnapshot = {
  ok: true,
  fetchedAt: 0,
  userId: null,
  plan: "unknown",
  walletTier: "unknown",
  planSlug: null,
  requestsLimit: null,
  requestsHardCap: null,
  requestsWindowSeconds: null,
  concurrencySoftLimit: 1,
  concurrencyHardCap: 1,
  requestsInWindow: 0,
  weightedRequestsInWindow: 0,
  requestsRemaining: null,
  weightedRemainingRequests: null,
  concurrentSessions: 0,
  weightedConcurrentSessions: 0,
  tokensIn: 0,
  tokensOut: 0,
  tokensCached: 0,
  windowStartedAt: null,
  windowResetsAt: null,
  windowRemainingMinutes: null,
  priorityLow: false,
  boxedUntil: null,
  boxedReason: null,
  unitsDemoted: false,
  demotedUntil: null,
  serviceMode: { current: "normal", resetsAt: null },
};

function makeGate(): ConcurrencyGate {
  const g = new ConcurrencyGate({
    hardCap: 1,
    softLimit: 1,
    releaseCooldownMs: 0,
    breakerThreshold: 1,
    breakerWindowMs: 60_000,
    breakerCooldownMs: 60_000,
    maxQueueDepth: 4,
    queueTimeoutMs: 100,
  });
  g.resize(1);
  return g;
}

function makeStubs() {
  let captureId = 0;
  const db = {
    startCapture: () => ++captureId,
    setState: () => {},
    updateRequestBody: () => {},
  } as unknown as CaptureDB;
  const ws = { broadcast: () => {} } as unknown as WsBroadcaster;
  const queue = { queueUpdate: () => {} } as unknown as WriteQueue;
  return { db, ws, queue };
}

const config = {
  target: "http://127.0.0.1:9",
  openaiPath: "chat/completions",
  stampClaudeCode: false,
  stampReasoningEffort: false,
  upstreamProtocol: "http1.1",
  incomingProtocol: "http1.1",
  upstreamTimeoutMs: 5000,
  captureBodyMaxBytes: 0,
  backgroundVision: false,
} as const;

const models = null as unknown as ModelsClient;
const vision = null as VisionHandoff | null;
const rateRef: RateLimiterRef = { current: null };

describe("W2: onTraffic timing — fires only after gate acquire", () => {
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("onTraffic is NOT called when the gate rejects (circuit_open)", async () => {
    const gate = makeGate();
    // Trip the breaker so acquire() rejects with circuit_open.
    gate.record429("concurrency");
    expect(gate.getStats(failSnap).breaker).toBe("open");

    let trafficCalls = 0;
    const onTraffic = () => {
      trafficCalls++;
    };

    const { db, ws, queue } = makeStubs();
    const { handleProxy } = createProxyHandler(
      db,
      ws,
      queue,
      // biome-ignore lint/suspicious/noExplicitAny: test-only config subset
      config as any,
      gate,
      rateRef,
      vision,
      models,
      onTraffic,
    );

    const req = new Request("http://proxy.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "test", messages: [] }),
    });
    const url = new URL(req.url);
    const res = await handleProxy(req, url);

    expect(trafficCalls).toBe(0);
    // Gate rejects with 503 (circuit_open maps to 503).
    expect(res.status).toBe(503);
  });

  test("onTraffic IS called when the gate accepts the request", async () => {
    const gate = makeGate();
    let trafficCalls = 0;
    const onTraffic = () => {
      trafficCalls++;
    };

    // Stub upstream fetch so the handler completes without a real network call.
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    const { db, ws, queue } = makeStubs();
    const { handleProxy } = createProxyHandler(
      db,
      ws,
      queue,
      // biome-ignore lint/suspicious/noExplicitAny: test-only config subset
      config as any,
      gate,
      rateRef,
      vision,
      models,
      onTraffic,
    );

    const req = new Request("http://proxy.test/v1/messages", {
      method: "POST",
      body: JSON.stringify({ model: "test", messages: [] }),
    });
    const url = new URL(req.url);
    const res = await handleProxy(req, url);

    expect(res.status).toBe(200);
    expect(trafficCalls).toBe(1);
  });
});
