import { describe, expect, test } from "bun:test";
import { ConcurrencyGate } from "../../src/limiter/index.js";

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

describe("ConcurrencyGate.shutdown clears onStatsChange callbacks", () => {
  test("onStatsChange callback does not fire after shutdown", () => {
    const g = new ConcurrencyGate(baseOpts);
    let callCount = 0;
    g.onStatsChange(() => {
      callCount++;
    });

    g.resize(2);
    expect(callCount).toBe(1);

    g.shutdown();

    g.resize(3);
    g.setHardCap(6);
    g.record429("concurrency");
    expect(callCount).toBe(1);
  });

  test("reconfigure calls emitStats unconditionally but callback stays cleared after shutdown", () => {
    const g = new ConcurrencyGate(baseOpts);
    let callCount = 0;
    g.onStatsChange(() => {
      callCount++;
    });

    g.reconfigure({ queueTimeoutMs: 200 });
    expect(callCount).toBe(1);

    g.shutdown();

    g.reconfigure({ queueTimeoutMs: 300 });
    expect(callCount).toBe(1);
  });
});
