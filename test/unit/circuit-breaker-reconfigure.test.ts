import { describe, expect, test } from "bun:test";
import { CircuitBreaker } from "../../src/limiter/circuit-breaker.js";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Accessor for the private 429 timestamp list (test-only). */
function ts429(b: CircuitBreaker): number[] {
  return (b as unknown as { concurrency429s: number[] }).concurrency429s;
}

describe("CircuitBreaker.reconfigure", () => {
  test("prunes stale 429s when windowMs shrinks", async () => {
    // threshold=5, windowMs=200. Push 4 429s below threshold so the
    // breaker stays closed. Wait until those entries are older than
    // a shorter window we reconfigure to. After reconfigure, the
    // internal concurrency429s list must be empty (entries pruned).
    // Without the fix, reconfigure only updates windowMs and leaves
    // stale entries in the array.
    const b = new CircuitBreaker(5, 200, 1000);
    b.record429("concurrency");
    b.record429("concurrency");
    b.record429("concurrency");
    b.record429("concurrency");
    expect(ts429(b).length).toBe(4);
    expect(b.getState()).toBe("closed");

    // 40ms > new window (30ms) but < old window (200ms).
    await wait(40);

    // Sanity: without reconfigure-pruning, the entries are still there
    // (record429's own filter has not run since the wait).
    expect(ts429(b).length).toBe(4);

    // Reconfigure to the short window. Stale 429s must be pruned.
    b.reconfigure({ windowMs: 30 });
    expect(ts429(b).length).toBe(0);
  });

  test("does not change breaker state during reconfigure (open stays open)", () => {
    // Open the breaker, then reconfigure. State must remain "open".
    const b = new CircuitBreaker(1, 10000, 999999);
    b.record429("concurrency");
    expect(b.getState()).toBe("open");

    b.reconfigure({ windowMs: 50, threshold: 100, cooldownMs: 1 });
    // No transition logic in reconfigure — state unchanged.
    expect(b.getState()).toBe("open");
  });

  test("does not change breaker state during reconfigure (closed stays closed)", () => {
    const b = new CircuitBreaker(5, 10000, 1000);
    expect(b.getState()).toBe("closed");

    b.reconfigure({ windowMs: 50, threshold: 1, cooldownMs: 1 });
    // Even though threshold dropped to 1, reconfigure must not trip.
    expect(b.getState()).toBe("closed");

    // Subsequent record429 uses the new threshold/window.
    b.record429("concurrency");
    expect(b.getState()).toBe("open");
  });

  test("subsequent record429 uses the new window", async () => {
    // After reconfigure to a short window, stale 429s older than the
    // new window must not count toward the threshold on the next
    // record429 (record429's own filter uses this.windowMs which is
    // now the new short value).
    const b = new CircuitBreaker(2, 30, 999999);
    b.record429("concurrency"); // fresh, within window
    await wait(40);
    // Stale entry pruned by record429's filter (windowMs=30). Only 1
    // fresh entry remains — below threshold of 2.
    b.record429("concurrency");
    expect(b.getState()).toBe("closed");
  });
});
