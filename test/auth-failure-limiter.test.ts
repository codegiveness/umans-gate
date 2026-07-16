// Unit tests for AuthFailureLimiter — brute-force protection on dashboard token auth.

import { expect, test } from "bun:test";
import { AuthFailureLimiter } from "../src/auth.js";

test("isLockedOut returns false when under threshold", () => {
  const limiter = new AuthFailureLimiter(10, 60);
  for (let i = 0; i < 9; i++) limiter.recordFailure();
  expect(limiter.isLockedOut()).toBe(false);
});

test("isLockedOut returns true when threshold reached", () => {
  const limiter = new AuthFailureLimiter(10, 60);
  for (let i = 0; i < 10; i++) limiter.recordFailure();
  expect(limiter.isLockedOut()).toBe(true);
});

test("recordFailure increments count", () => {
  const limiter = new AuthFailureLimiter(5, 60);
  limiter.recordFailure();
  limiter.recordFailure();
  expect(limiter.isLockedOut()).toBe(false);
  limiter.recordFailure();
  limiter.recordFailure();
  limiter.recordFailure();
  expect(limiter.isLockedOut()).toBe(true);
});

test("reset clears all failures", () => {
  const limiter = new AuthFailureLimiter(3, 60);
  limiter.recordFailure();
  limiter.recordFailure();
  limiter.recordFailure();
  expect(limiter.isLockedOut()).toBe(true);
  limiter.reset();
  expect(limiter.isLockedOut()).toBe(false);
});

test("old failures expire after window", () => {
  const limiter = new AuthFailureLimiter(3, 1);
  const now = Date.now();
  limiter.recordFailure(now);
  limiter.recordFailure(now);
  limiter.recordFailure(now);
  expect(limiter.isLockedOut(now)).toBe(true);
  // 2 seconds later — past the 1-second window
  const later = now + 2000;
  expect(limiter.isLockedOut(later)).toBe(false);
});

test("partial failures within window are retained", () => {
  const limiter = new AuthFailureLimiter(5, 60);
  const now = Date.now();
  limiter.recordFailure(now - 30000);
  limiter.recordFailure(now);
  expect(limiter.isLockedOut(now)).toBe(false);
  limiter.recordFailure(now);
  limiter.recordFailure(now);
  limiter.recordFailure(now);
  expect(limiter.isLockedOut(now)).toBe(true);
});

test("reset after successful auth prevents lockout", () => {
  const limiter = new AuthFailureLimiter(3, 60);
  limiter.recordFailure();
  limiter.recordFailure();
  limiter.reset();
  limiter.recordFailure();
  expect(limiter.isLockedOut()).toBe(false);
});
