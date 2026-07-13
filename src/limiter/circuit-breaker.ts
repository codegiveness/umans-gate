import type { BreakerState } from "./types.js";

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private concurrency429s: number[] = [];
  private openedAt = 0;
  private threshold: number;
  private windowMs: number;
  private cooldownMs: number;

  constructor(threshold: number, windowMs: number, cooldownMs: number) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
  }

  reconfigure(opts: { threshold?: number; windowMs?: number; cooldownMs?: number }): void {
    if (opts.threshold !== undefined) this.threshold = opts.threshold;
    if (opts.windowMs !== undefined) this.windowMs = opts.windowMs;
    if (opts.cooldownMs !== undefined) this.cooldownMs = opts.cooldownMs;
  }

  getState(): BreakerState {
    return this.state;
  }

  /** If open and cooldown has elapsed, transition to half_open. Returns the
   *  current state AFTER any transition. */
  maybeHalfOpen(): BreakerState {
    if (this.state === "open") {
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.state = "half_open";
      }
    }
    return this.state;
  }

  record429(type: "concurrency" | "rate_limit" | "gateway"): void {
    if (type !== "concurrency") return;
    const now = Date.now();
    this.concurrency429s.push(now);
    this.concurrency429s = this.concurrency429s.filter((t) => now - t < this.windowMs);
    if (this.concurrency429s.length >= this.threshold) {
      if (this.state === "closed" || this.state === "half_open") {
        this.state = "open";
        this.openedAt = now;
      }
    }
  }

  recordSuccess(): void {
    if (this.state === "half_open") {
      this.state = "closed";
      this.concurrency429s = [];
    }
  }
}
