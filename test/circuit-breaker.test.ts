import { describe, expect, test } from "bun:test";
import { ConcurrencyGate, type GateError } from "../src/limiter/index.js";
import type { UsageSnapshot } from "../src/types.js";

const baseOpts = {
  hardCap: 4,
  softLimit: 4,
  releaseCooldownMs: 0,
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
  serviceMode: { current: "normal", resetsAt: null },
};

describe("CircuitBreaker characterization via ConcurrencyGate", () => {
  test("threshold concurrency 429s trip breaker → next acquire rejects circuit_open", async () => {
    const g = new ConcurrencyGate({ ...baseOpts, breakerThreshold: 3 });
    g.resize(1);

    g.record429("concurrency");
    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("closed");

    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("open");

    await expect(g.acquire()).rejects.toMatchObject({ code: "circuit_open" });
  });

  test("rate_limit 429s do not trip breaker", () => {
    const g = new ConcurrencyGate({ ...baseOpts, breakerThreshold: 3 });
    g.resize(1);

    for (let i = 0; i < 10; i++) {
      g.record429("rate_limit");
    }

    expect(g.getStats(failSnap).breaker).toBe("closed");
  });

  test("gateway 429s do not trip breaker", () => {
    const g = new ConcurrencyGate({ ...baseOpts, breakerThreshold: 3 });
    g.resize(1);

    for (let i = 0; i < 10; i++) {
      g.record429("gateway");
    }

    expect(g.getStats(failSnap).breaker).toBe("closed");
  });

  test("cooldown elapses → half_open → next acquire allowed", async () => {
    const g = new ConcurrencyGate({
      ...baseOpts,
      breakerThreshold: 1,
      breakerCooldownMs: 20,
    });
    g.resize(1);

    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("open");

    await new Promise((r) => setTimeout(r, 35));

    const permit = await g.acquire();
    expect(g.getStats(failSnap).breaker).toBe("half_open");
    permit.release();
  });

  test("success after half_open → closed → can trip again", async () => {
    const g = new ConcurrencyGate({
      ...baseOpts,
      breakerThreshold: 1,
      breakerCooldownMs: 20,
    });
    g.resize(1);

    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("open");

    await new Promise((r) => setTimeout(r, 35));
    const permit = await g.acquire();
    expect(g.getStats(failSnap).breaker).toBe("half_open");

    g.recordSuccess();
    expect(g.getStats(failSnap).breaker).toBe("closed");

    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("open");
    await expect(g.acquire()).rejects.toMatchObject({ code: "circuit_open" });

    permit.release();
  });

  test("half_open → open on concurrency 429 without success", async () => {
    const g = new ConcurrencyGate({
      ...baseOpts,
      breakerThreshold: 1,
      breakerCooldownMs: 20,
    });
    g.resize(1);

    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("open");

    await new Promise((r) => setTimeout(r, 35));
    const permit = await g.acquire();
    expect(g.getStats(failSnap).breaker).toBe("half_open");

    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("open");

    await expect(g.acquire()).rejects.toMatchObject({ code: "circuit_open" });

    permit.release();
  });

  test("concurrency 429s outside breakerWindowMs expire and do not count", async () => {
    const g = new ConcurrencyGate({
      ...baseOpts,
      breakerThreshold: 2,
      breakerWindowMs: 60,
      breakerCooldownMs: 999999,
    });
    g.resize(1);

    g.record429("concurrency");
    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("open");

    // wait for the window to expire so old 429s drop off
    await new Promise((r) => setTimeout(r, 70));

    // state stays open because cooldown is huge
    expect(g.getStats(failSnap).breaker).toBe("open");

    // next acquire still rejects while open
    await expect(g.acquire()).rejects.toMatchObject({ code: "circuit_open" });

    // wait for cooldown so breaker can half-open; a fresh grant+success closes it
    // (using a very long cooldown means we cannot half-open, so verify reconfig shortens it)
    g.reconfigure({ breakerCooldownMs: 0 });
    const permit = await g.acquire();
    expect(g.getStats(failSnap).breaker).toBe("half_open");
    g.recordSuccess();
    expect(g.getStats(failSnap).breaker).toBe("closed");

    // old 429s are gone; one new 429 should not be enough to trip
    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("closed");

    permit.release();
  });

  test("breaker state is observable via getStats(snapshot).breaker", () => {
    const g = new ConcurrencyGate({ ...baseOpts, breakerThreshold: 3 });
    g.resize(1);

    expect(g.getStats(failSnap).breaker).toBe("closed");

    g.record429("concurrency");
    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("closed");

    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("open");
  });

  test("mixed rate_limit and gateway 429s do not count toward threshold", () => {
    const g = new ConcurrencyGate({
      ...baseOpts,
      breakerThreshold: 2,
    });
    g.resize(1);

    g.record429("rate_limit");
    g.record429("gateway");
    g.record429("rate_limit");
    g.record429("gateway");

    expect(g.getStats(failSnap).breaker).toBe("closed");

    g.record429("concurrency");
    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("open");
  });

  test("half_open single-flight: only one probe allowed while permit held", async () => {
    const g = new ConcurrencyGate({
      ...baseOpts,
      breakerThreshold: 1,
      breakerCooldownMs: 20,
      queueTimeoutMs: 99999,
      maxQueueDepth: 10,
    });
    g.resize(1);

    const held = await g.acquire();

    g.record429("concurrency");
    expect(g.getStats(failSnap).breaker).toBe("open");

    await new Promise((r) => setTimeout(r, 35));

    const results: ("pending" | "fulfilled" | "circuit_open")[] = [];
    const promises = Array.from({ length: 5 }, () => {
      const p = g.acquire();
      p.then(
        () => results.push("fulfilled"),
        (e: GateError) => results.push(e.code === "circuit_open" ? "circuit_open" : "pending"),
      );
      return p;
    });

    await new Promise((r) => setTimeout(r, 10));

    expect(g.getStats(failSnap).breaker).toBe("half_open");
    expect(g.getStats(failSnap).queued).toBe(1);
    expect(results.filter((r) => r === "circuit_open").length).toBe(4);
    expect(results.filter((r) => r === "fulfilled").length).toBe(0);

    held.release();
    const probe = await promises[0];
    g.recordSuccess();
    expect(g.getStats(failSnap).breaker).toBe("closed");
    probe.release();

    for (let i = 1; i < promises.length; i++) {
      await promises[i].then(() => {}).catch(() => {});
    }
  });
});
