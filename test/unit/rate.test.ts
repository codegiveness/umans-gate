import { expect, test } from "bun:test";
import { SlidingWindowRateLimiter } from "../../src/rate.js";

test("allows first N requests, rejects N+1", () => {
  const rl = new SlidingWindowRateLimiter({ limit: 3, windowSeconds: 3600 });
  expect(rl.check(1, 1000).allowed).toBe(true);
  expect(rl.check(1, 2000).allowed).toBe(true);
  expect(rl.check(1, 3000).allowed).toBe(true);
  const r = rl.check(1, 4000);
  expect(r.allowed).toBe(false);
  expect(r.retryAfterSeconds).toBeGreaterThan(0);
});

test("peek does not record, check does", () => {
  const rl = new SlidingWindowRateLimiter({ limit: 1, windowSeconds: 3600 });
  expect(rl.peek(1, 1000).allowed).toBe(true);
  expect(rl.peek(1, 2000).allowed).toBe(true);
  expect(rl.check(1, 3000).allowed).toBe(true);
  expect(rl.check(1, 4000).allowed).toBe(false);
});

test("prunes old timestamps after window passes", () => {
  const rl = new SlidingWindowRateLimiter({ limit: 2, windowSeconds: 1 });
  expect(rl.check(1, 1000).allowed).toBe(true);
  expect(rl.check(1, 1500).allowed).toBe(true);
  expect(rl.check(1, 1600).allowed).toBe(false);
  // Window is 1s = 1000ms. At t=2601, the t=1000 entry is aged out.
  expect(rl.check(1, 2601).allowed).toBe(true);
});

test("retryAfterSeconds calculated from oldest timestamp", () => {
  const rl = new SlidingWindowRateLimiter({ limit: 1, windowSeconds: 10 });
  rl.check(1, 1000);
  const r = rl.check(1, 2000);
  expect(r.allowed).toBe(false);
  // Oldest at 1000, window 10000ms → expires at 11000. Now=2000 → 9s left.
  expect(r.retryAfterSeconds).toBe(9);
});

test("count reflects pruned state", () => {
  const rl = new SlidingWindowRateLimiter({ limit: 100, windowSeconds: 1 });
  rl.check(1, 1000);
  rl.check(1, 1500);
  rl.check(1, 2000);
  expect(rl.count(2500)).toBe(2);
  expect(rl.count(2999)).toBe(1);
  expect(rl.count(3001)).toBe(0);
});

test("binary search pruning handles large arrays", () => {
  const rl = new SlidingWindowRateLimiter({ limit: 10000, windowSeconds: 1 });
  for (let i = 0; i < 1000; i++) {
    rl.check(1, i);
  }
  expect(rl.count(1000)).toBe(1000);
  expect(rl.count(2001)).toBeLessThan(1000);
});

test("weighted entries consume budget by weight", () => {
  const rl = new SlidingWindowRateLimiter({ limit: 10, windowSeconds: 3600 });
  // weight=3 consumes 3 of 10
  expect(rl.check(3, 1000).allowed).toBe(true);
  expect(rl.check(3, 2000).allowed).toBe(true);
  // 3+3=6, weight=5 would make 11 > 10
  expect(rl.check(5, 3000).allowed).toBe(false);
  // 3+3+4=10 exactly fits
  expect(rl.check(4, 3000).allowed).toBe(true);
});

test("peek with weight does not record", () => {
  const rl = new SlidingWindowRateLimiter({ limit: 5, windowSeconds: 3600 });
  // peek with weight=5 should say allowed but not record
  expect(rl.peek(5, 1000).allowed).toBe(true);
  // count should still be 0
  expect(rl.count(1000)).toBe(0);
  // now actually check with weight=3
  expect(rl.check(3, 1000).allowed).toBe(true);
  // peek weight=3: current=3, 3+3=6 > 5
  expect(rl.peek(3, 2000).allowed).toBe(false);
  // check weight=2: 3+2=5 fits
  expect(rl.check(2, 2000).allowed).toBe(true);
  expect(rl.count(2000)).toBe(5);
});

test("count returns total weight not entry count", () => {
  const rl = new SlidingWindowRateLimiter({ limit: 100, windowSeconds: 3600 });
  rl.check(2, 1000);
  rl.check(3, 2000);
  rl.check(5, 3000);
  // 3 entries but total weight = 10
  expect(rl.count(3500)).toBe(10);
});
