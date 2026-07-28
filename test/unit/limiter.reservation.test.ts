import { expect, test } from "bun:test";
import { ConcurrencyGate } from "../../src/limiter/index.js";
import type { UsageSnapshot } from "../../src/types.js";

const baseOpts = {
  hardCap: 8,
  softLimit: 8,
  releaseCooldownMs: 0,
  breakerThreshold: 100,
  breakerWindowMs: 5000,
  breakerCooldownMs: 50,
  maxQueueDepth: 100,
  queueTimeoutMs: 10_000,
};

const dummySnapshot: UsageSnapshot = {
  ok: true,
  fetchedAt: Date.now(),
  userId: null,
  plan: "Code Max",
  planSlug: "code_max",
  requestsLimit: null,
  requestsHardCap: null,
  requestsWindowSeconds: null,
  concurrencySoftLimit: 4,
  concurrencyHardCap: 8,
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

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

type Permit = Awaited<ReturnType<ConcurrencyGate["acquire"]>>;

test("S1 happy-reservation: limit=4 mainRes=1 visionRes=1, 3 main + 1 vision fits; 4th main blocks when vision unfilled", async () => {
  const g = new ConcurrencyGate({
    ...baseOpts,
    intentions: { main: 1, vision: 1 },
  });
  g.resize(4);

  const m1 = await g.acquire({ intention: "main" });
  const m2 = await g.acquire({ intention: "main" });
  const v1 = await g.acquire({ intention: "vision" });

  expect(g.getStats(dummySnapshot).active).toBe(3);
  expect(g.getStats(dummySnapshot).activeByIntention).toEqual({ main: 2, vision: 1 });

  // Vision's reservation (1) is satisfied by v1, so the 4th slot is free for main.
  const m4 = await g.acquire({ intention: "main" });
  expect(g.getStats(dummySnapshot).active).toBe(4);

  m4.release();
  m1.release();
  m2.release();
  v1.release();
  g.shutdown();
});

test("S2 main-borrows-idle-vision-slot: 3 main active, no vision demand; 4th main borrows vision's idle reservation", async () => {
  const g = new ConcurrencyGate({
    ...baseOpts,
    intentions: { main: 1, vision: 1 },
  });
  g.resize(4);

  const m1 = await g.acquire({ intention: "main" });
  const m2 = await g.acquire({ intention: "main" });
  const m3 = await g.acquire({ intention: "main" });

  expect(g.getStats(dummySnapshot).active).toBe(3);

  // Vision has 0 active and 0 queued — its reservation is borrowable.
  // Main can use the 4th slot immediately instead of blocking.
  const m4 = await g.acquire({ intention: "main" });
  expect(g.getStats(dummySnapshot).active).toBe(4);
  expect(g.getStats(dummySnapshot).activeByIntention).toEqual({ main: 4, vision: 0 });

  m1.release();
  m2.release();
  m3.release();
  m4.release();
  g.shutdown();
});

test("S2b vision-reservation-restored-on-demand: after main borrows vision's idle slot, releasing restores vision priority", async () => {
  const g = new ConcurrencyGate({
    ...baseOpts,
    intentions: { main: 1, vision: 1 },
  });
  g.resize(4);

  // Fill all 4 slots with main (borrowing vision's idle reservation).
  const m1 = await g.acquire({ intention: "main" });
  const m2 = await g.acquire({ intention: "main" });
  const m3 = await g.acquire({ intention: "main" });
  const m4 = await g.acquire({ intention: "main" });
  expect(g.getStats(dummySnapshot).active).toBe(4);

  // Vision request queues (at capacity).
  const v1Promise = g.acquire({ intention: "vision" });
  let v1Resolved = false;
  v1Promise.then(() => {
    v1Resolved = true;
  });
  await sleep(10);
  expect(v1Resolved).toBe(false);

  // Release a main → vision gets the slot (FIFO + reservation).
  m1.release();
  await sleep(10);
  expect(v1Resolved).toBe(true);

  (await v1Promise).release();
  m2.release();
  m3.release();
  m4.release();
  g.shutdown();
});

test("S2c main-reaches-full-hardcap-16: hardCap=16 visionRes=1, main fills all 16 slots when vision idle", async () => {
  const g = new ConcurrencyGate({
    ...baseOpts,
    hardCap: 16,
    softLimit: 16,
    intentions: { main: 1, vision: 1 },
  });
  g.resize(16);

  const permits: Permit[] = [];
  for (let i = 0; i < 16; i++) {
    permits.push(await g.acquire({ intention: "main" }));
  }
  expect(g.getStats(dummySnapshot).active).toBe(16);
  expect(g.getStats(dummySnapshot).activeByIntention).toEqual({ main: 16, vision: 0 });

  for (const p of permits) p.release();
  g.shutdown();
});

test("S3 vision-cannot-starve-main: main reservation honored among queued vision waiters", async () => {
  const g = new ConcurrencyGate({
    ...baseOpts,
    intentions: { main: 1, vision: 1 },
  });
  g.resize(4);

  // Queue five waiters in order: 2 vision, then 1 main, then 2 vision.
  // With limit=4 and reservations {main:1, vision:1}, the main waiter must be
  // granted (its reserved slot) even though visions are ahead of it in queue.
  // Once main's reservation is satisfied by an active permit, vision may use
  // the remaining slot — so 4 of 5 resolve, with the 5th queued.
  const promises: Promise<Permit>[] = [];
  promises.push(g.acquire({ intention: "vision" }));
  promises.push(g.acquire({ intention: "vision" }));
  promises.push(g.acquire({ intention: "main" }));
  promises.push(g.acquire({ intention: "vision" }));
  promises.push(g.acquire({ intention: "vision" }));

  const permits: Permit[] = await Promise.all(promises.slice(0, 4));

  expect(g.getStats(dummySnapshot).activeByIntention).toEqual({ main: 1, vision: 3 });
  expect(g.getStats(dummySnapshot).queued).toBe(1);

  for (const p of permits) p.release();
  const queued: Permit[] = await Promise.all(promises.slice(3));
  for (const p of queued) p.release();
  g.shutdown();
});

test("S3 main-cannot-starve-vision: vision reservation honored among queued main waiters", async () => {
  const g = new ConcurrencyGate({
    ...baseOpts,
    intentions: { main: 1, vision: 1 },
  });
  g.resize(4);

  const promises: Promise<Permit>[] = [];
  promises.push(g.acquire({ intention: "main" }));
  promises.push(g.acquire({ intention: "main" }));
  promises.push(g.acquire({ intention: "vision" }));
  promises.push(g.acquire({ intention: "main" }));
  promises.push(g.acquire({ intention: "main" }));

  const permits: Permit[] = await Promise.all(promises.slice(0, 4));

  expect(g.getStats(dummySnapshot).activeByIntention).toEqual({ main: 3, vision: 1 });
  expect(g.getStats(dummySnapshot).queued).toBe(1);

  for (const p of permits) p.release();
  const queued: Permit[] = await Promise.all(promises.slice(3));
  for (const p of queued) p.release();
  g.shutdown();
});

test("S4 FIFO-on-vacant-slots: head waiter granted first when a slot frees (mixed intentions)", async () => {
  const g = new ConcurrencyGate({
    ...baseOpts,
    intentions: { main: 1, vision: 1 },
  });
  g.resize(4);

  // Fill to limit: 3 main (main's reservation satisfied, vision's reservation
  // still reserves 1 slot so main capacity = 3) + 1 vision.
  const mains: Permit[] = [];
  for (let i = 0; i < 3; i++) {
    mains.push(await g.acquire({ intention: "main" }));
  }
  const vis0 = await g.acquire({ intention: "vision" });
  expect(g.getStats(dummySnapshot).active).toBe(4);

  // Queue in order: vision1, vision2, main1. All must block (limit reached).
  const order: string[] = [];
  const vision1 = g.acquire({ intention: "vision" }).then((p) => {
    order.push("vision1");
    return p;
  });
  const vision2 = g.acquire({ intention: "vision" }).then((p) => {
    order.push("vision2");
    return p;
  });
  const main1 = g.acquire({ intention: "main" }).then((p) => {
    order.push("main1");
    return p;
  });

  await sleep(30);
  expect(order).toEqual([]);

  // Release the vision permit: vision1 (head, fits) is granted first.
  vis0.release();
  await sleep(20);
  expect(order).toEqual(["vision1"]);

  // Release a main: vision2 is granted next.
  mains[0].release();
  await sleep(20);
  expect(order).toEqual(["vision1", "vision2"]);

  // Release another main: main1 is granted.
  mains[1].release();
  await sleep(20);
  expect(order).toEqual(["vision1", "vision2", "main1"]);

  (await vision1).release();
  (await vision2).release();
  (await main1).release();
  mains[2].release();
  g.shutdown();
});

test("S5 FIFO-single-intention: fill to limit, queue A then B, release one grants A before B", async () => {
  const g = new ConcurrencyGate({
    ...baseOpts,
    intentions: { main: 1 },
  });
  g.resize(2);

  const p1 = await g.acquire({ intention: "main" });
  const p2 = await g.acquire({ intention: "main" });
  expect(g.getStats(dummySnapshot).active).toBe(2);

  const order: string[] = [];
  const a = g.acquire({ intention: "main" }).then((p) => {
    order.push("A");
    return p;
  });
  const b = g.acquire({ intention: "main" }).then((p) => {
    order.push("B");
    return p;
  });

  await sleep(30);
  expect(order).toEqual([]);

  p1.release();
  await sleep(20);
  expect(order).toEqual(["A"]);

  p2.release();
  await sleep(20);
  expect(order).toEqual(["A", "B"]);

  (await a).release();
  (await b).release();
  g.shutdown();
});

test("S6 over-subscribed reservations fall back to pure capacity: limit=1 mainRes=1 visionRes=1, both intentions can acquire one at a time", async () => {
  const g = new ConcurrencyGate({
    ...baseOpts,
    hardCap: 1,
    softLimit: 1,
    intentions: { main: 1, vision: 1 },
  });

  // With total reservation (2) > limit (1), proportional split would give each
  // intention ~500, below a single permit's weight of 1000. The fallback must
  // allow pure capacity granting so neither intention starves.
  const m1 = await g.acquire({ intention: "main" });
  expect(g.getStats(dummySnapshot).active).toBe(1);
  expect(g.getStats(dummySnapshot).activeByIntention).toEqual({ main: 1, vision: 0 });

  m1.release();
  await sleep(10);

  const v1 = await g.acquire({ intention: "vision" });
  expect(g.getStats(dummySnapshot).active).toBe(1);
  expect(g.getStats(dummySnapshot).activeByIntention).toEqual({ main: 0, vision: 1 });

  v1.release();
  g.shutdown();
});
