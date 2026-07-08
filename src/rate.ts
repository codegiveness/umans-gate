// Sliding-window rate limiter for the pro-tier 200-req/5h limit.
// Binary-search pruning; check() records, peek() does not.

export interface RateLimitConfig {
  limit: number;
  windowSeconds: number;
}

export interface RateCheckResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number | null;
}

export class SlidingWindowRateLimiter {
  private timestamps: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;

  constructor(config: RateLimitConfig) {
    this.limit = config.limit;
    this.windowMs = config.windowSeconds * 1000;
  }

  check(now: number = Date.now()): RateCheckResult {
    this.prune(now);
    if (this.timestamps.length >= this.limit) {
      const oldest = this.timestamps[0];
      const retryAfter = Math.ceil((oldest + this.windowMs - now) / 1000);
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, retryAfter) };
    }
    this.timestamps.push(now);
    return {
      allowed: true,
      remaining: this.limit - this.timestamps.length,
      retryAfterSeconds: null,
    };
  }

  peek(now: number = Date.now()): RateCheckResult {
    this.prune(now);
    const remaining = Math.max(0, this.limit - this.timestamps.length);
    if (this.timestamps.length >= this.limit) {
      const oldest = this.timestamps[0];
      const retryAfter = Math.ceil((oldest + this.windowMs - now) / 1000);
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, retryAfter) };
    }
    return { allowed: true, remaining, retryAfterSeconds: null };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let lo = 0;
    let hi = this.timestamps.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.timestamps[mid] < cutoff) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) this.timestamps.splice(0, lo);
  }

  count(now: number = Date.now()): number {
    this.prune(now);
    return this.timestamps.length;
  }
}
