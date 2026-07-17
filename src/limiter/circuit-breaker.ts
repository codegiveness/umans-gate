import type { BreakerState } from "./types.js";

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private concurrency429s: number[] = [];
  private openedAt = 0;
  private threshold: number;
  private windowMs: number;
  private cooldownMs: number;
  private halfOpenProbeStarted = false;

  constructor(threshold: number, windowMs: number, cooldownMs: number) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.cooldownMs = cooldownMs;
  }

  reconfigure(opts: { threshold?: number; windowMs?: number; cooldownMs?: number }): void {
    if (opts.threshold !== undefined) this.threshold = opts.threshold;
    if (opts.windowMs !== undefined) this.windowMs = opts.windowMs;
    if (opts.cooldownMs !== undefined) this.cooldownMs = opts.cooldownMs;
    // Prune stale 429s against the (possibly new) window so the array
    // does not retain entries that record429's filter would drop anyway.
    // Does NOT transition breaker state — pruning is bookkeeping only.
    this.concurrency429s = this.concurrency429s.filter((t) => Date.now() - t < this.windowMs);
  }

  getState(): BreakerState {
    return this.state;
  }

  /** If open and cooldown has elapsed, transition to half_open at most once
   *  per opening — the first caller becomes the single-flight probe and sees
   *  "half_open"; later callers see "open" (probe already in flight) until
   *  recordSuccess closes the breaker or record429 re-opens it. */
  maybeHalfOpen(): BreakerState {
    if (this.state === "open") {
      if (this.halfOpenProbeStarted) {
        return "open";
      }
      const elapsed = Date.now() - this.openedAt;
      if (elapsed >= this.cooldownMs) {
        this.halfOpenProbeStarted = true;
        this.state = "half_open";
      }
    } else if (this.state === "half_open" && this.halfOpenProbeStarted) {
      return "open";
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
        this.halfOpenProbeStarted = false;
      }
    }
  }

  recordSuccess(): void {
    if (this.state === "half_open") {
      this.state = "closed";
      this.concurrency429s = [];
      this.halfOpenProbeStarted = false;
    }
  }

  resetHalfOpenProbe(): void {
    if (this.state === "half_open" && this.halfOpenProbeStarted) {
      this.halfOpenProbeStarted = false;
      this.state = "open";
      this.openedAt = Date.now();
    }
  }
}
