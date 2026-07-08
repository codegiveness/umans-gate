// Concurrency gate — resizable semaphore with circuit breaker + release cooldown.
// 9th request at hard cap enqueues; waits for a slot or rejects on timeout/full.
//
// Internal accounting uses 1000× scaled integers (SCALE) to avoid floating-point
// drift from fractional reservation ratios and weights. All public getters
// return decimal values.

import { createLogger } from "./logger.js";
import type { BreakerState, GateConfig, GateStats, ProxyConfig, UsageSnapshot } from "./types.js";

export type { BreakerState };

/** Raw config keys that should trigger a gate reconfigure on reload. */
export const GATE_RECONFIG_FIELDS = new Set<keyof ProxyConfig>([
  "breakerThreshold",
  "breakerWindowMs",
  "breakerCooldownMs",
  "queueTimeoutMs",
  "maxQueueDepth",
  "releaseCooldownMs",
  "concurrencyMainReservation",
  "concurrencyVisionReservation",
]);

const log = createLogger("limiter");

interface Waiter {
  resolve: (permit: Permit) => void;
  reject: (e: GateError) => void;
  enqueuedAt: number;
  weight: number;
  intention: string;
  signal?: AbortSignal;
  onAcquire?: () => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface Permit {
  release: () => void;
}

export interface ConcurrencyGateOptions {
  hardCap: number;
  softLimit: number;
  releaseCooldownMs: number;
  breakerThreshold: number;
  breakerWindowMs: number;
  breakerCooldownMs: number;
  maxQueueDepth: number;
  queueTimeoutMs: number;
  intentions?: Record<string, number>;
}

export class GateError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "GateError";
    this.code = code;
  }
}

export function gateOptionsFromConfig(config: GateConfig): ConcurrencyGateOptions {
  return {
    hardCap: config.concurrencyHardCap,
    softLimit: config.concurrencySoftLimit,
    releaseCooldownMs: config.releaseCooldownMs,
    breakerThreshold: config.breakerThreshold,
    breakerWindowMs: config.breakerWindowMs,
    breakerCooldownMs: config.breakerCooldownMs,
    maxQueueDepth: config.maxQueueDepth,
    queueTimeoutMs: config.queueTimeoutMs,
    intentions: {
      main: config.concurrencyMainReservation,
      vision: config.concurrencyVisionReservation,
    },
  };
}

export class ConcurrencyGate {
  private static readonly SCALE = 1000;

  private active = 0;
  private limit = 1;
  private hardCap: number;
  private softLimit: number;
  private releaseCooldownMs: number;
  private breakerThreshold: number;
  private breakerWindowMs: number;
  private breakerCooldownMs: number;
  private maxQueueDepth: number;
  private queueTimeoutMs: number;
  private waiters: Waiter[] = [];
  private breaker: BreakerState = "closed";
  private concurrency429s: number[] = [];
  private breakerOpenedAt = 0;
  private cooldownTimers = new Set<ReturnType<typeof setTimeout>>();
  private onStatsCb: (() => void) | null = null;
  private reservations: Record<string, number>;
  private activeByIntention: Record<string, number>;
  private queuedByIntention: Record<string, number>;

  constructor(opts: ConcurrencyGateOptions) {
    const S = ConcurrencyGate.SCALE;
    this.hardCap = Math.max(1, Math.floor(opts.hardCap)) * S;
    this.softLimit = Math.max(1, Math.floor(opts.softLimit)) * S;
    this.limit = Math.max(S, Math.min(this.softLimit, this.hardCap));
    this.releaseCooldownMs = opts.releaseCooldownMs;
    this.breakerThreshold = opts.breakerThreshold;
    this.breakerWindowMs = opts.breakerWindowMs;
    this.breakerCooldownMs = opts.breakerCooldownMs;
    this.maxQueueDepth = opts.maxQueueDepth;
    this.queueTimeoutMs = opts.queueTimeoutMs;
    const src = opts.intentions ?? { main: 1 };
    this.reservations = {};
    for (const key of Object.keys(src)) {
      this.reservations[key] = Math.round(src[key] * S);
    }
    this.activeByIntention = {};
    this.queuedByIntention = {};
    for (const key of Object.keys(this.reservations)) {
      this.activeByIntention[key] = 0;
      this.queuedByIntention[key] = 0;
    }
    this.assertInvariants();
  }

  /** Hot-reload reconfigurable parameters. Does NOT affect the soft limit
   *  (which is driven by usage.onChange). Updates breaker/queue/cooldown. */
  reconfigure(opts: Partial<ConcurrencyGateOptions>): void {
    if (opts.releaseCooldownMs !== undefined) this.releaseCooldownMs = opts.releaseCooldownMs;
    if (opts.breakerThreshold !== undefined) this.breakerThreshold = opts.breakerThreshold;
    if (opts.breakerWindowMs !== undefined) this.breakerWindowMs = opts.breakerWindowMs;
    if (opts.breakerCooldownMs !== undefined) this.breakerCooldownMs = opts.breakerCooldownMs;
    if (opts.maxQueueDepth !== undefined) this.maxQueueDepth = opts.maxQueueDepth;
    if (opts.queueTimeoutMs !== undefined) this.queueTimeoutMs = opts.queueTimeoutMs;
    if (opts.intentions !== undefined) {
      const S = ConcurrencyGate.SCALE;
      this.reservations = {};
      for (const key of Object.keys(opts.intentions)) {
        this.reservations[key] = Math.round(opts.intentions[key] * S);
      }
      for (const key of Object.keys(this.reservations)) {
        if (this.activeByIntention[key] === undefined) this.activeByIntention[key] = 0;
        if (this.queuedByIntention[key] === undefined) this.queuedByIntention[key] = 0;
      }
    }
    this.assertInvariants();
    this.emitStats();
  }

  onStatsChange(cb: () => void): void {
    this.onStatsCb = cb;
  }

  getLimit(): number {
    return this.limit / ConcurrencyGate.SCALE;
  }

  getIntentionActive(intention: string): number {
    return (this.activeByIntention[intention] ?? 0) / ConcurrencyGate.SCALE;
  }

  getIntentionQueued(intention: string): number {
    return this.queuedByIntention[intention] ?? 0;
  }

  resize(newLimit: number): void {
    const S = ConcurrencyGate.SCALE;
    const scaled = Math.round(newLimit * S);
    const clamped = Math.max(S, Math.min(scaled, this.hardCap));
    if (clamped === this.limit) return;
    this.limit = clamped;
    this.drainWaiters();
    this.assertInvariants();
    this.emitStats();
  }

  /** Update the hard cap (e.g. from /v1/usage reconciliation).
   *  Clamps the soft limit down if it now exceeds the new hard cap.
   *
   *  Policy: `hard_cap` is a hard grant boundary, NOT a hard real-time ceiling.
   *  Lowering the cap does NOT evict active permits. Transient over-cap states
   *  are expected until in-flight permits complete naturally. */
  setHardCap(newHardCap: number): void {
    const S = ConcurrencyGate.SCALE;
    const cap = Math.max(1, Math.floor(newHardCap)) * S;
    if (cap === this.hardCap) return;
    this.hardCap = cap;
    if (this.softLimit > cap) this.softLimit = cap;
    if (this.limit > cap) {
      this.limit = cap;
      this.drainWaiters();
    }
    if (this.active > cap) {
      const scaledActive = this.active / S;
      const excess = (this.active - cap) / S;
      log.warn(
        `[limiter.ts] setHardCap(${newHardCap}) reduced cap below active=${scaledActive}; ${excess} permits remain in-flight until completion (transient over-cap — see setHardCap docs)`,
      );
    }
    this.assertInvariants();
    this.emitStats();
  }

  /** Update the persisted soft limit (from /v1/usage). Does NOT change the
   *  effective limit — that's driven by usage.onChange with priorityLow adjustment. */
  setSoftLimit(newSoftLimit: number): void {
    const S = ConcurrencyGate.SCALE;
    const v = Math.max(1, Math.floor(newSoftLimit)) * S;
    if (v === this.softLimit) return;
    this.softLimit = v;
    this.assertInvariants();
    this.emitStats();
  }

  acquire(
    opts: {
      weight?: number;
      signal?: AbortSignal;
      onAcquire?: () => void;
      intention?: string;
    } = {},
  ): Promise<Permit> {
    const S = ConcurrencyGate.SCALE;
    const weight = Math.round((opts.weight ?? 1) * S);
    if (weight <= 0) {
      throw new GateError("invalid_weight", "weight must be positive");
    }
    const intention = opts.intention ?? "main";
    return new Promise((resolve, reject) => {
      if (this.breaker === "open") {
        const elapsed = Date.now() - this.breakerOpenedAt;
        if (elapsed >= this.breakerCooldownMs) {
          this.breaker = "half_open";
          this.emitStats();
        } else {
          reject(new GateError("circuit_open", "Circuit breaker open"));
          return;
        }
      }

      if (this.canGrant(intention, weight)) {
        this.grant(resolve, opts.onAcquire, weight, intention);
        return;
      }

      if (this.waiters.length >= this.maxQueueDepth) {
        reject(new GateError("queue_full", "Concurrency queue full"));
        return;
      }

      const timeout = setTimeout(() => {
        this.removeWaiter(waiter);
        reject(new GateError("timeout", "Queue timeout exceeded"));
      }, this.queueTimeoutMs);

      const waiter: Waiter = {
        resolve,
        reject,
        enqueuedAt: Date.now(),
        weight,
        intention,
        signal: opts.signal,
        onAcquire: opts.onAcquire,
        timeout,
      };
      this.waiters.push(waiter);
      this.queuedByIntention[intention] = (this.queuedByIntention[intention] ?? 0) + 1;
      this.emitStats();

      opts.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          this.removeWaiter(waiter);
          reject(new GateError("aborted", "Client disconnected while enqueued"));
        },
        { once: true },
      );
    });
  }

  /** Effective reservations clamped so sum(effRes) <= limit. Each is at least 1
   *  when limit allows, but if limit < intention count, some may be 0. */
  private effectiveReservations(): Record<string, number> {
    const keys = Object.keys(this.reservations);
    const sum = keys.reduce((s, k) => s + (this.reservations[k] ?? 0), 0);
    if (sum <= this.limit) {
      const out: Record<string, number> = {};
      for (const k of keys) out[k] = this.reservations[k] ?? 0;
      return out;
    }
    const out: Record<string, number> = {};
    let remaining = this.limit;
    for (const k of keys) {
      const scaled = Math.floor(((this.reservations[k] ?? 0) / sum) * this.limit);
      const v = Math.max(0, Math.min(scaled, remaining));
      out[k] = v;
      remaining -= v;
    }
    return out;
  }

  /** Capacity available to intention I: limit minus reserved slots of other
   *  intentions that have not yet been filled by active permits. An intention
   *  whose active count meets or exceeds its reservation frees those slots for
   *  general use. Demand is irrelevant — the reservation guarantees a slot is
   *  available when the other intention eventually requests it. */
  private capacity(intention: string, effRes: Record<string, number>): number {
    let reserved = 0;
    for (const k of Object.keys(effRes)) {
      if (k === intention) continue;
      const active = this.activeByIntention[k] ?? 0;
      const res = effRes[k] ?? 0;
      reserved += Math.max(0, res - active);
    }
    return this.limit - reserved;
  }

  /** Grant conditions: reservation bypass OR capacity check. */
  private canGrant(intention: string, weight: number): boolean {
    const effRes = this.effectiveReservations();
    const reserved = effRes[intention] ?? 0;
    if (this.active + weight > this.limit) return false;
    if ((this.activeByIntention[intention] ?? 0) + weight <= reserved) {
      return true;
    }
    return this.active + weight <= this.capacity(intention, effRes);
  }

  private grant(
    resolve: (p: Permit) => void,
    onAcquire: (() => void) | undefined,
    weight: number,
    intention: string,
  ): void {
    this.active += weight;
    this.activeByIntention[intention] = (this.activeByIntention[intention] ?? 0) + weight;
    onAcquire?.();
    this.assertInvariants();
    this.emitStats();
    let released = false;
    resolve({
      release: () => {
        if (released) return;
        released = true;
        this.releasePermit(weight, intention);
      },
    });
  }

  private releasePermit(weight: number, intention: string): void {
    const t = setTimeout(() => {
      this.active = Math.max(0, this.active - weight);
      this.activeByIntention[intention] = Math.max(
        0,
        (this.activeByIntention[intention] ?? 0) - weight,
      );
      this.cooldownTimers.delete(t);
      this.drainWaiters();
      this.assertInvariants();
      this.emitStats();
    }, this.releaseCooldownMs);
    this.cooldownTimers.add(t);
  }

  private drainWaiters(): void {
    for (let i = 0; i < this.waiters.length; ) {
      const next = this.waiters[i];
      if (!this.canGrant(next.intention, next.weight)) {
        i++;
        continue;
      }
      this.waiters.splice(i, 1);
      this.queuedByIntention[next.intention] = Math.max(
        0,
        (this.queuedByIntention[next.intention] ?? 0) - 1,
      );
      clearTimeout(next.timeout);
      this.grant(next.resolve, next.onAcquire, next.weight, next.intention);
    }
    this.assertInvariants();
  }

  private removeWaiter(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) {
      this.waiters.splice(i, 1);
      this.queuedByIntention[w.intention] = Math.max(
        0,
        (this.queuedByIntention[w.intention] ?? 0) - 1,
      );
      this.assertInvariants();
      this.emitStats();
    }
  }

  record429(type: "concurrency" | "rate_limit" | "gateway"): void {
    if (type !== "concurrency") return;
    const now = Date.now();
    this.concurrency429s.push(now);
    this.concurrency429s = this.concurrency429s.filter((t) => now - t < this.breakerWindowMs);
    if (this.concurrency429s.length >= this.breakerThreshold && this.breaker === "closed") {
      this.breaker = "open";
      this.breakerOpenedAt = now;
      this.emitStats();
    }
    this.assertInvariants();
  }

  recordSuccess(): void {
    if (this.breaker === "half_open") {
      this.breaker = "closed";
      this.concurrency429s = [];
      this.emitStats();
    }
    this.assertInvariants();
  }

  getStats(snapshot: UsageSnapshot): GateStats {
    const S = ConcurrencyGate.SCALE;
    const now = Date.now();
    const boxed = snapshot.boxedUntil !== null && snapshot.boxedUntil > now;
    const activeByIntention: Record<string, number> = {};
    for (const k of Object.keys(this.activeByIntention)) {
      activeByIntention[k] = this.activeByIntention[k] / S;
    }
    const reservations: Record<string, number> = {};
    for (const k of Object.keys(this.reservations)) {
      reservations[k] = this.reservations[k] / S;
    }
    return {
      active: this.active / S,
      queued: this.waiters.length,
      softLimit: this.softLimit / S,
      hardCap: this.hardCap / S,
      tier: snapshot.plan,
      breaker: this.breaker,
      boxed,
      boxedReason: snapshot.boxedReason,
      priorityLow: snapshot.priorityLow,
      requestsRemaining: snapshot.requestsRemaining,
      requestsInWindow: snapshot.requestsInWindow,
      requestsLimit: snapshot.requestsLimit,
      windowSeconds: snapshot.requestsWindowSeconds,
      usageOk: snapshot.ok,
      lastUsageFetch: snapshot.fetchedAt || null,
      activeByIntention,
      queuedByIntention: { ...this.queuedByIntention },
      reservations,
    };
  }

  private assertInvariants(): void {
    const S = ConcurrencyGate.SCALE;
    if (!(S <= this.limit && this.limit <= this.hardCap)) {
      log.warn(
        `[limiter.ts] invariant violation: SCALE(${S}) <= limit(${this.limit}) <= hardCap(${this.hardCap})`,
      );
    }
    if (!Number.isInteger(this.active)) {
      log.warn(`[limiter.ts] invariant warning: active(${this.active}) is not an integer`);
    }
    if (!Number.isInteger(this.limit)) {
      log.warn(`[limiter.ts] invariant warning: limit(${this.limit}) is not an integer`);
    }
    if (!Number.isInteger(this.hardCap)) {
      log.warn(`[limiter.ts] invariant warning: hardCap(${this.hardCap}) is not an integer`);
    }
    if (this.active > this.hardCap) {
      const excess = (this.active - this.hardCap) / S;
      log.warn(
        `[limiter.ts] invariant warning: active(${this.active}) > hardCap(${this.hardCap}); transient over-cap by ${excess} (in-flight permits will drain)`,
      );
    }
    if (this.active < 0) {
      log.warn(`[limiter.ts] invariant violation: active(${this.active}) < 0`);
    }
  }

  private emitStats(): void {
    this.onStatsCb?.();
  }

  shutdown(): void {
    for (const t of this.cooldownTimers) clearTimeout(t);
    this.cooldownTimers.clear();
    for (const w of this.waiters) {
      clearTimeout(w.timeout);
      this.queuedByIntention[w.intention] = Math.max(
        0,
        (this.queuedByIntention[w.intention] ?? 0) - 1,
      );
      w.reject(new GateError("shutdown", "Shutting down"));
    }
    this.waiters = [];
    this.assertInvariants();
  }
}
