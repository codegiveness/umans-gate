/**
 * Dashboard token authentication helpers.
 *
 * Single source of truth for constant-time token comparison and auth-failure
 * rate limiting used by the request dispatcher (health, metrics, viewer API)
 * and the WebSocket upgrade handler.
 */

import { timingSafeEqual } from "node:crypto";

/**
 * Constant-time string comparison.
 * Returns false immediately when lengths differ (Node's `timingSafeEqual`
 * throws on length mismatch, so we guard before calling it).
 */
export function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Check whether a request carries a valid `Authorization: Bearer <token>`
 * header matching the configured dashboard token.
 */
export function isTokenAuthorized(req: Request, token: string): boolean {
  const auth = req.headers.get("authorization");
  if (!auth) return false;
  return tokensEqual(auth, `Bearer ${token}`);
}

/**
 * Sliding-window auth-failure limiter.
 *
 * Tracks failed auth attempts in a time window. When the threshold is
 * exceeded, subsequent requests are rejected with 429 Too Many Requests
 * without even checking the token, making brute-force attacks impractical
 * even on a local-only proxy.
 *
 * Design: simple array of timestamps, pruned on each call. Good enough
 * for a personal-use tool — no need for a distributed rate limiter.
 */
export class AuthFailureLimiter {
  private failures: number[] = [];
  private readonly maxFailures: number;
  private readonly windowMs: number;

  /**
   * @param maxFailures  Max failed attempts allowed in the window before lockout.
   * @param windowSeconds  Size of the sliding window in seconds.
   */
  constructor(maxFailures = 10, windowSeconds = 60) {
    this.maxFailures = maxFailures;
    this.windowMs = windowSeconds * 1000;
  }

  /**
   * Record a failed auth attempt.
   * Call this when `isTokenAuthorized` / `tokensEqual` returns false.
   */
  recordFailure(now: number = Date.now()): void {
    this.prune(now);
    this.failures.push(now);
  }

  /**
   * Whether further auth attempts should be rejected without checking.
   * When true, the caller should return 429 immediately.
   */
  isLockedOut(now: number = Date.now()): boolean {
    this.prune(now);
    return this.failures.length >= this.maxFailures;
  }

  /**
   * Clear the failure history (e.g. after a successful auth).
   * Prevents lockout when the user eventually provides the correct token
   * after some failures.
   */
  reset(): void {
    this.failures = [];
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    const idx = this.failures.findIndex((t) => t >= cutoff);
    if (idx === -1) {
      this.failures = [];
    } else if (idx > 0) {
      this.failures = this.failures.slice(idx);
    }
  }
}
