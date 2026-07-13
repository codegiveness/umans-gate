// Sliding-window rate limiter for the pro-tier request limit.
// Tracks weighted entries: each request consumes `weight` units of the budget.
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

interface Entry {
  time: number;
  weight: number;
}

export class SlidingWindowRateLimiter {
  private entries: Entry[] = [];
  private runningSum = 0;
  private readonly limit;
  private readonly windowMs;

  constructor(config: RateLimitConfig) {
    this.limit = config.limit;
    this.windowMs = config.windowSeconds * 1000;
  }

  /** Record a request with the given weight. Returns whether it was allowed. */
  check(weight = 1, now: number = Date.now()): RateCheckResult {
    this.prune(now);
    const currentWeight = this.runningSum;
    if (currentWeight + weight > this.limit) {
      const oldest = this.entries[0];
      const retryAfter = oldest ? Math.ceil((oldest.time + this.windowMs - now) / 1000) : 1;
      return {
        allowed: false,
        remaining: Math.max(0, this.limit - currentWeight),
        retryAfterSeconds: Math.max(1, retryAfter),
      };
    }
    this.entries.push({ time: now, weight });
    this.runningSum += weight;
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - currentWeight - weight),
      retryAfterSeconds: null,
    };
  }

  /** Check whether a request with the given weight would be allowed, without recording. */
  peek(weight = 1, now: number = Date.now()): RateCheckResult {
    this.prune(now);
    const currentWeight = this.runningSum;
    if (currentWeight + weight > this.limit) {
      const oldest = this.entries[0];
      const retryAfter = oldest ? Math.ceil((oldest.time + this.windowMs - now) / 1000) : 1;
      return {
        allowed: false,
        remaining: Math.max(0, this.limit - currentWeight),
        retryAfterSeconds: Math.max(1, retryAfter),
      };
    }
    return {
      allowed: true,
      remaining: Math.max(0, this.limit - currentWeight - weight),
      retryAfterSeconds: null,
    };
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs;
    let lo = 0;
    let hi = this.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.entries[mid].time < cutoff) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) {
      for (let i = 0; i < lo; i++) this.runningSum -= this.entries[i].weight;
      this.entries.splice(0, lo);
    }
  }

  /** Total weight of entries currently in the window. */
  count(now: number = Date.now()): number {
    this.prune(now);
    return this.runningSum;
  }
}
