import { expect, test } from "bun:test";
import { ConcurrencyGate, GateError } from "../src/limiter/index.js";
import type { UsageSnapshot } from "../src/types.js";

const opts = {
  hardCap: 4,
  softLimit: 4,
  releaseCooldownMs: 10,
  breakerThreshold: 3,
  breakerWindowMs: 5000,
  breakerCooldownMs: 50,
  maxQueueDepth: 10,
  queueTimeoutMs: 100,
};

const failSnap: UsageSnapshot = {
  ok: false,
  fetchedAt: 0,
  plan: "unknown",
  requestsLimit: null,
  requestsHardCap: null,
  requestsWindowSeconds: null,
  concurrencySoftLimit: 1,
  concurrencyHardCap: 4,
  requestsInWindow: 0,
  requestsRemaining: null,
  concurrentSessions: 4,
  priorityLow: true,
  boxedUntil: null,
  boxedReason: null,
  unitsDemoted: false,
  demotedUntil: null,
};

test("acquire up to limit resolves immediately", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(3);
  const p1 = g.acquire();
  const p2 = g.acquire();
  const p3 = g.acquire();
  await expect(p1).resolves.toBeDefined();
  await expect(p2).resolves.toBeDefined();
  await expect(p3).resolves.toBeDefined();
  (await p1).release();
  (await p2).release();
  (await p3).release();
});

test("N+1 acquire blocks until a slot frees", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(1);
  const p1 = await g.acquire();
  const p2Promise = g.acquire();
  let resolved = false;
  p2Promise.then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(resolved).toBe(false);
  p1.release();
  await new Promise((r) => setTimeout(r, 20));
  expect(resolved).toBe(true);
  (await p2Promise).release();
});

test("resize up wakes waiters", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(1);
  const p1 = await g.acquire();
  const p2Promise = g.acquire();
  let resolved = false;
  p2Promise.then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 10));
  expect(resolved).toBe(false);
  g.resize(2);
  await new Promise((r) => setTimeout(r, 10));
  expect(resolved).toBe(true);
  (await p2Promise).release();
  p1.release();
});

test("queue full rejects with queue_full", async () => {
  const g = new ConcurrencyGate({
    ...opts,
    releaseCooldownMs: 0,
    maxQueueDepth: 1,
    queueTimeoutMs: 99999,
  });
  g.resize(1);
  await g.acquire();
  const queued = g.acquire();
  await new Promise((r) => setTimeout(r, 5));
  await expect(g.acquire()).rejects.toMatchObject({ code: "queue_full" });
  g.shutdown();
  await queued.catch(() => {});
});

test("queue timeout rejects with timeout", async () => {
  const g = new ConcurrencyGate({
    ...opts,
    releaseCooldownMs: 0,
    queueTimeoutMs: 30,
  });
  g.resize(0);
  g.resize(1);
  await g.acquire();
  await expect(g.acquire()).rejects.toMatchObject({ code: "timeout" });
});

test("5 concurrency-429s trip breaker to open", async () => {
  const g = new ConcurrencyGate({
    ...opts,
    breakerThreshold: 3,
    breakerCooldownMs: 999999,
    releaseCooldownMs: 0,
  });
  g.resize(2);
  g.record429("concurrency");
  g.record429("concurrency");
  expect(g.getStats(failSnap).breaker).toBe("closed");
  g.record429("concurrency");
  expect(g.getStats(failSnap).breaker).toBe("open");
  await expect(g.acquire()).rejects.toMatchObject({ code: "circuit_open" });
});

test("rate_limit 429 does not trip breaker", () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(1);
  for (let i = 0; i < 10; i++) g.record429("rate_limit");
  expect(g.getStats(failSnap).breaker).toBe("closed");
});

test("gateway 429 does not trip breaker", () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(1);
  for (let i = 0; i < 10; i++) g.record429("gateway");
  expect(g.getStats(failSnap).breaker).toBe("closed");
});

test("breaker transitions open → half_open → closed", async () => {
  const g = new ConcurrencyGate({
    ...opts,
    breakerThreshold: 1,
    breakerCooldownMs: 20,
    releaseCooldownMs: 0,
  });
  g.resize(1);
  g.record429("concurrency");
  expect(g.getStats(failSnap).breaker).toBe("open");
  await new Promise((r) => setTimeout(r, 30));
  // Now should transition to half_open on next acquire
  const p = g.acquire();
  await new Promise((r) => setTimeout(r, 5));
  g.recordSuccess();
  expect(g.getStats(failSnap).breaker).toBe("closed");
  (await p).release();
});

test("release cooldown delays active decrement", async () => {
  const g = new ConcurrencyGate({
    ...opts,
    releaseCooldownMs: 50,
    queueTimeoutMs: 99999,
  });
  g.resize(1);
  const p = await g.acquire();
  const stats1 = g.getStats(failSnap);
  expect(stats1.active).toBe(1);
  p.release();
  // Immediately after release, active should still be 1 (cooldown)
  const stats2 = g.getStats(failSnap);
  expect(stats2.active).toBe(1);
  await new Promise((r) => setTimeout(r, 60));
  const stats3 = g.getStats(failSnap);
  expect(stats3.active).toBe(0);
});

test("getStats returns correct counts", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(2);
  const p1 = await g.acquire();
  const p2 = await g.acquire();
  const q = g.acquire(); // queued
  await new Promise((r) => setTimeout(r, 5));
  const stats = g.getStats(failSnap);
  expect(stats.active).toBe(2);
  expect(stats.queued).toBe(1);
  expect(stats.softLimit).toBe(4);
  expect(stats.hardCap).toBe(4);
  p1.release();
  p2.release();
  await q.then((perm) => perm.release()).catch(() => {});
});

test("shutdown rejects all waiters", async () => {
  const g = new ConcurrencyGate({
    ...opts,
    releaseCooldownMs: 0,
    queueTimeoutMs: 99999,
  });
  g.resize(0);
  g.resize(1);
  await g.acquire();
  const queued = g.acquire();
  g.shutdown();
  await expect(queued).rejects.toMatchObject({ code: "shutdown" });
});

test("weighted acquire: weight=0.5 fits 2 in limit=1", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(1);
  const p1 = g.acquire({ weight: 0.5 });
  const p2 = g.acquire({ weight: 0.5 });
  await expect(p1).resolves.toBeDefined();
  await expect(p2).resolves.toBeDefined();
  (await p1).release();
  (await p2).release();
});

test("weighted acquire: weight=0.5 + weight=1.0 blocks when exceeds limit", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(1);
  const p1 = await g.acquire({ weight: 0.5 });
  const p2Promise = g.acquire({ weight: 1.0 });
  let resolved = false;
  p2Promise.then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(resolved).toBe(false);
  p1.release();
  await new Promise((r) => setTimeout(r, 20));
  expect(resolved).toBe(true);
  (await p2Promise).release();
});

test("weighted acquire: default weight is 1.0", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(1);
  const p1 = await g.acquire();
  const p2Promise = g.acquire();
  let resolved = false;
  p2Promise.then(() => {
    resolved = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(resolved).toBe(false);
  p1.release();
  await new Promise((r) => setTimeout(r, 20));
  expect(resolved).toBe(true);
  (await p2Promise).release();
});

test("permit release is idempotent — double release does not corrupt active count", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(2);
  const p = await g.acquire({ weight: 0.5 });
  p.release();
  p.release();
  await new Promise((r) => setTimeout(r, 10));
  expect(g.getStats(failSnap).active).toBe(0);
});

test("setHardCap reduction warns when active exceeds new cap and does not evict", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(4);
  const ps = [await g.acquire(), await g.acquire(), await g.acquire(), await g.acquire()];
  const warns: string[] = [];
  const orig = console.error;
  console.error = (msg: string) => warns.push(msg);
  g.setHardCap(2);
  console.error = orig;
  expect(g.getStats(failSnap).active).toBe(4);
  expect(g.getStats(failSnap).hardCap).toBe(2);
  expect(warns.length).toBeGreaterThan(0);
  for (const p of ps) p.release();
  await new Promise((r) => setTimeout(r, 10));
});

test("weight=0.125 fits 8 in limit=1 (eighths scale cleanly at 1000x)", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(1);
  const permits = Array.from({ length: 8 }, () => g.acquire({ weight: 0.125 }));
  await Promise.all(permits);
  expect(g.getStats(failSnap).active).toBe(1);
  for (const p of permits) (await p).release();
  await new Promise((r) => setTimeout(r, 10));
});

test("getStats returns decimal active with weight=0.5", async () => {
  const g = new ConcurrencyGate({ ...opts, releaseCooldownMs: 0 });
  g.resize(2);
  const p = await g.acquire({ weight: 0.5 });
  expect(g.getStats(failSnap).active).toBe(0.5);
  p.release();
  await new Promise((r) => setTimeout(r, 10));
});

test("getStats activeByIntention returns decimal values", async () => {
  const g = new ConcurrencyGate({
    ...opts,
    releaseCooldownMs: 0,
    intentions: { main: 2, vision: 1 },
  });
  g.resize(3);
  const p = await g.acquire({ intention: "main", weight: 0.5 });
  expect(g.getStats(failSnap).activeByIntention.main).toBe(0.5);
  p.release();
  await new Promise((r) => setTimeout(r, 10));
});

test("getStats reservations return decimal values", () => {
  const g = new ConcurrencyGate({
    ...opts,
    intentions: { main: 1, vision: 1 },
  });
  const stats = g.getStats(failSnap);
  expect(stats.reservations.main).toBe(1);
  expect(stats.reservations.vision).toBe(1);
});
