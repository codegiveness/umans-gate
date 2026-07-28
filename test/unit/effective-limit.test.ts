import { expect, test } from "bun:test";
import { ConcurrencyGate } from "../../src/limiter/index.js";
import type { UsageSnapshot } from "../../src/types.js";

const opts = {
  hardCap: 16,
  softLimit: 8,
  releaseCooldownMs: 0,
  breakerThreshold: 99,
  breakerWindowMs: 5000,
  breakerCooldownMs: 50,
  maxQueueDepth: 10,
  queueTimeoutMs: 100,
};

const snap: UsageSnapshot = {
  ok: true,
  fetchedAt: 0,
  userId: null,
  plan: "Code Max",
  planSlug: null,
  requestsLimit: null,
  requestsHardCap: null,
  requestsWindowSeconds: null,
  concurrencySoftLimit: 8,
  concurrencyHardCap: 16,
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

test("effectiveLimit equals resized limit", () => {
  const g = new ConcurrencyGate(opts);
  g.resize(8);
  const stats = g.getStats(snap);
  expect(stats.effectiveLimit).toBe(8);
  expect(stats.hardCap).toBe(16);
  expect(stats.softLimit).toBe(8);
});

test("effectiveLimit changes when gate is resized to hard cap", () => {
  const g = new ConcurrencyGate(opts);
  g.resize(8);
  expect(g.getStats(snap).effectiveLimit).toBe(8);
  g.resize(16);
  expect(g.getStats(snap).effectiveLimit).toBe(16);
});

test("effectiveLimit reflects priorityLow adjustment when caller resizes down", () => {
  const g = new ConcurrencyGate(opts);
  g.resize(7);
  const stats = g.getStats(snap);
  expect(stats.effectiveLimit).toBe(7);
});

test("effectiveLimit is clamped to hardCap on resize", () => {
  const g = new ConcurrencyGate(opts);
  g.resize(99);
  const stats = g.getStats(snap);
  expect(stats.effectiveLimit).toBe(16);
  expect(stats.hardCap).toBe(16);
});

test("effectiveLimit is at least 1 on resize", () => {
  const g = new ConcurrencyGate(opts);
  g.resize(0);
  const stats = g.getStats(snap);
  expect(stats.effectiveLimit).toBe(1);
});

test("effectiveLimit not greater than hardCap when hardCap lowered", () => {
  const g = new ConcurrencyGate(opts);
  g.resize(16);
  g.setHardCap(6);
  const stats = g.getStats(snap);
  expect(stats.effectiveLimit).toBeLessThanOrEqual(6);
  expect(stats.hardCap).toBe(6);
});
