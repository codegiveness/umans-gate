import { expect, test } from "bun:test";
import { ConcurrencyGate } from "../src/limiter/index.js";
import type { UsageSnapshot } from "../src/types.js";

const opts = {
  hardCap: 4,
  softLimit: 4,
  releaseCooldownMs: 0,
  breakerThreshold: 3,
  breakerWindowMs: 5000,
  breakerCooldownMs: 50,
  maxQueueDepth: 10,
  queueTimeoutMs: 100,
};

const fakeSnap = (): UsageSnapshot => ({
  ok: true,
  fetchedAt: 0,
  userId: null,
  plan: "unknown",
  planSlug: null,
  requestsLimit: null,
  requestsHardCap: null,
  requestsWindowSeconds: null,
  concurrencySoftLimit: 4,
  concurrencyHardCap: 4,
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
});

// Mock fetch so fetchConcurrencyLimits sees a response where hard_cap/limit
// are the non-numeric string "unlimited" — the original bug source.
test("fetchConcurrencyLimits rejects non-numeric hard_cap (e.g. 'unlimited')", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          limits: {
            concurrency: { hard_cap: "unlimited", limit: "unlimited" },
          },
          usage: {},
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    )) as unknown as typeof fetch;
  try {
    const { fetchConcurrencyLimits } = await import("../src/usage/reconciler.js");
    const result = await fetchConcurrencyLimits("https://example.test", "test-key");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("malformed concurrency limits");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("setHardCap(NaN) clamps to 1 instead of poisoning the gate", () => {
  const g = new ConcurrencyGate({ ...opts });
  g.setHardCap(Number.NaN);
  const stats = g.getStats(fakeSnap());
  expect(Number.isFinite(stats.hardCap)).toBe(true);
  expect(stats.hardCap).toBe(1);
});

test("setHardCap(Infinity) clamps to 1 instead of poisoning the gate", () => {
  const g = new ConcurrencyGate({ ...opts });
  g.setHardCap(Number.POSITIVE_INFINITY);
  const stats = g.getStats(fakeSnap());
  expect(Number.isFinite(stats.hardCap)).toBe(true);
  expect(stats.hardCap).toBe(1);
});

test("setSoftLimit(NaN) clamps to 1 instead of poisoning the gate", () => {
  const g = new ConcurrencyGate({ ...opts });
  g.setSoftLimit(Number.NaN);
  const stats = g.getStats(fakeSnap());
  expect(Number.isFinite(stats.softLimit)).toBe(true);
  expect(stats.softLimit).toBe(1);
});

test("setSoftLimit(Infinity) clamps to 1 instead of poisoning the gate", () => {
  const g = new ConcurrencyGate({ ...opts });
  g.setSoftLimit(Number.POSITIVE_INFINITY);
  const stats = g.getStats(fakeSnap());
  expect(Number.isFinite(stats.softLimit)).toBe(true);
  expect(stats.softLimit).toBe(1);
});

test("gate with NaN-protected values still enforces a finite limit (not unlimited)", async () => {
  const g = new ConcurrencyGate({ ...opts });
  // Poison attempt: setHardCap(NaN) must clamp to 1, not bypass the gate.
  g.setHardCap(Number.NaN);
  // Effective limit must be finite and equal to 1 (clamped by setHardCap).
  expect(Number.isFinite(g.getLimit())).toBe(true);
  expect(g.getLimit()).toBe(1);
  // Acquire the single available permit.
  const p1 = await g.acquire();
  expect(p1).toBeDefined();
  // A second acquire must NOT resolve immediately — the gate is at limit 1.
  const p2 = g.acquire();
  let resolved = false;
  p2.then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(resolved).toBe(false);
  p1.release();
  await new Promise((r) => setTimeout(r, 20));
  expect(resolved).toBe(true);
  (await p2).release();
});
