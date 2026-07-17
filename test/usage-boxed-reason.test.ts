import { expect, test } from "bun:test";
import { ConcurrencyGate } from "../src/limiter/index.js";
import type { UsageSnapshot } from "../src/types.js";

// Mirror of the onChange predicate in src/index.ts:325-334.
// This is the unit under test — the gate-resize decision based on
// boxedReason. When the predicate here matches the source, the test
// pins the contract: rate_limit* reasons do NOT clamp the gate to 1,
// while quota_exceeded and null/undefined DO (conservative default).
const applyBoxedReason = (gate: ConcurrencyGate, snap: UsageSnapshot, effective: number): void => {
  const boxed = snap.boxedUntil !== null && snap.boxedUntil > Date.now();
  if (boxed && !snap.boxedReason?.toLowerCase().startsWith("rate_limit")) {
    gate.resize(1);
  } else {
    gate.resize(effective);
  }
};

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

const baseSnap = (): UsageSnapshot => ({
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

const boxedSnap = (reason: string | null): UsageSnapshot => ({
  ...baseSnap(),
  boxedUntil: Date.now() + 60_000,
  boxedReason: reason,
});

test('boxedReason "rate_limited" does NOT clamp gate to 1', () => {
  const g = new ConcurrencyGate({ ...opts });
  applyBoxedReason(g, boxedSnap("rate_limited"), 4);
  expect(g.getLimit()).toBe(4);
});

test('boxedReason "rate_limit_exceeded" does NOT clamp gate to 1', () => {
  const g = new ConcurrencyGate({ ...opts });
  applyBoxedReason(g, boxedSnap("rate_limit_exceeded"), 4);
  expect(g.getLimit()).toBe(4);
});

test('boxedReason "rate_limit" does NOT clamp gate to 1', () => {
  const g = new ConcurrencyGate({ ...opts });
  applyBoxedReason(g, boxedSnap("rate_limit"), 4);
  expect(g.getLimit()).toBe(4);
});

test('boxedReason "Rate_Limited" (mixed case) does NOT clamp gate to 1', () => {
  const g = new ConcurrencyGate({ ...opts });
  applyBoxedReason(g, boxedSnap("Rate_Limited"), 4);
  expect(g.getLimit()).toBe(4);
});

test('boxedReason "quota_exceeded" clamps gate to 1', () => {
  const g = new ConcurrencyGate({ ...opts });
  applyBoxedReason(g, boxedSnap("quota_exceeded"), 4);
  expect(g.getLimit()).toBe(1);
});

test("boxedReason null clamps gate to 1 (conservative default)", () => {
  const g = new ConcurrencyGate({ ...opts });
  applyBoxedReason(g, boxedSnap(null), 4);
  expect(g.getLimit()).toBe(1);
});
