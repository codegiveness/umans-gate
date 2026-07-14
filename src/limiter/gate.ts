// Concurrency gate — resizable semaphore with circuit breaker + release cooldown.
// 9th request at hard cap enqueues; waits for a slot or rejects on timeout/full.
//
// Internal accounting uses 1000× scaled integers (SCALE) to avoid floating-point
// drift from fractional reservation ratios and weights. All public getters
// return decimal values.
//
// Internally composed of two cohesive classes:
//   Semaphore     — active count, acquire/release, waiter queue, FIFO ordering,
//                   reservations, capacity checks, release cooldown.
//   CircuitBreaker — failure counting, state (closed/open/half-open), thresholds.
// ConcurrencyGate preserves its existing public API and delegates to both.

import { createLogger } from "../logger.js";
import type { GateStats, UsageSnapshot } from "../types.js";
import { CircuitBreaker } from "./circuit-breaker.js";
import {
  type ConcurrencyGateOptions,
  GateError,
  type Permit,
  SCALE,
  type Waiter,
} from "./types.js";

const log = createLogger("limiter");

// ---------------------------------------------------------------------------
// Semaphore — active count, acquire/release, waiter queue, FIFO ordering,
//             reservations, capacity checks, release cooldown.
// ---------------------------------------------------------------------------

class Semaphore {
  private active = 0;
  private limit = SCALE;
  private hardCap: number;
  private softLimit: number;
  private releaseCooldownMs: number;
  private maxQueueDepth: number;
  private queueTimeoutMs: number;
  private waiters: Waiter[] = [];
  private reservations: Record<string, number>;
  private activeByIntention: Record<string, number>;
  private queuedByIntention: Record<string, number>;
  private cooldownTimers = new Set<ReturnType<typeof setTimeout>>();
  private pendingReleases: Array<{ weight: number; intention: string }> = [];
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onEmitStats: () => void;

  constructor(opts: ConcurrencyGateOptions, onEmitStats: () => void) {
    this.onEmitStats = onEmitStats;
    this.hardCap = Math.max(1, Math.floor(opts.hardCap)) * SCALE;
    this.softLimit = Math.max(1, Math.floor(opts.softLimit)) * SCALE;
    this.limit = Math.max(SCALE, Math.min(this.softLimit, this.hardCap));
    this.releaseCooldownMs = opts.releaseCooldownMs;
    this.maxQueueDepth = opts.maxQueueDepth;
    this.queueTimeoutMs = opts.queueTimeoutMs;
    const src = opts.intentions ?? { main: 1 };
    this.reservations = {};
    for (const key of Object.keys(src)) {
      this.reservations[key] = Math.round(src[key] * SCALE);
    }
    this.activeByIntention = {};
    this.queuedByIntention = {};
    for (const key of Object.keys(this.reservations)) {
      this.activeByIntention[key] = 0;
      this.queuedByIntention[key] = 0;
    }
    this.assertInvariants();
  }

  reconfigure(opts: Partial<ConcurrencyGateOptions>): void {
    if (opts.releaseCooldownMs !== undefined) this.releaseCooldownMs = opts.releaseCooldownMs;
    if (opts.maxQueueDepth !== undefined) this.maxQueueDepth = opts.maxQueueDepth;
    if (opts.queueTimeoutMs !== undefined) this.queueTimeoutMs = opts.queueTimeoutMs;
    if (opts.intentions !== undefined) {
      this.reservations = {};
      for (const key of Object.keys(opts.intentions)) {
        this.reservations[key] = Math.round(opts.intentions[key] * SCALE);
      }
      for (const key of Object.keys(this.reservations)) {
        if (this.activeByIntention[key] === undefined) this.activeByIntention[key] = 0;
        if (this.queuedByIntention[key] === undefined) this.queuedByIntention[key] = 0;
      }
    }
    this.assertInvariants();
  }

  getActive(): number {
    return this.active;
  }

  getLimit(): number {
    return this.limit;
  }

  getHardCap(): number {
    return this.hardCap;
  }

  getSoftLimit(): number {
    return this.softLimit;
  }

  getWaiterCount(): number {
    return this.waiters.length;
  }

  getReservations(): Record<string, number> {
    return this.reservations;
  }

  getActiveByIntention(): Record<string, number> {
    return this.activeByIntention;
  }

  getQueuedByIntention(): Record<string, number> {
    return this.queuedByIntention;
  }

  getIntentionActive(intention: string): number {
    return (this.activeByIntention[intention] ?? 0) / SCALE;
  }

  getIntentionQueued(intention: string): number {
    return this.queuedByIntention[intention] ?? 0;
  }

  resize(newLimit: number): boolean {
    const scaled = Math.round(newLimit * SCALE);
    const clamped = Math.max(SCALE, Math.min(scaled, this.hardCap));
    if (clamped === this.limit) return false;
    this.limit = clamped;
    this.drainWaiters();
    this.assertInvariants();
    return true;
  }

  setHardCap(newHardCap: number): boolean {
    const cap = Math.max(1, Math.floor(newHardCap)) * SCALE;
    if (cap === this.hardCap) return false;
    this.hardCap = cap;
    if (this.softLimit > cap) this.softLimit = cap;
    if (this.limit > cap) {
      this.limit = cap;
      this.drainWaiters();
    }
    if (this.active > cap) {
      const excess = (this.active - cap) / SCALE;
      log.warn(
        `[gate.ts] setHardCap(${newHardCap}) reduced cap below active=${this.active / SCALE}; ${excess} permits remain in-flight until completion (transient over-cap — see setHardCap docs)`,
      );
    }
    this.assertInvariants();
    return true;
  }

  setSoftLimit(newSoftLimit: number): boolean {
    const v = Math.max(1, Math.floor(newSoftLimit)) * SCALE;
    if (v === this.softLimit) return false;
    this.softLimit = v;
    this.assertInvariants();
    return true;
  }

  /** Attempts to acquire a permit. Returns true if granted immediately,
   *  false if the caller should enqueue (or reject if queue is full).
   *
   *  When total reservations exceed the limit (over-subscribed), the
   *  proportional split in effectiveReservations() may reduce each
   *  intention's reservation below a single permit's weight. In that
   *  case, fall back to a pure capacity check: any intention may acquire
   *  if active + weight ≤ limit. Reservations only gate borrowing when
   *  they are not over-subscribed. */
  canGrant(intention: string, weight: number): boolean {
    const effRes = this.effectiveReservations();
    const reserved = effRes[intention] ?? 0;
    if (this.active + weight > this.limit) return false;
    if ((this.activeByIntention[intention] ?? 0) + weight <= reserved) {
      return true;
    }
    // When reservations are over-subscribed (proportional split reduced
    // them below raw values), allow pure capacity-based granting.
    const overSubscribed = Object.keys(this.reservations).some(
      (k) => (this.reservations[k] ?? 0) > (effRes[k] ?? 0),
    );
    if (overSubscribed) {
      return this.active + weight <= this.limit;
    }
    return this.active + weight <= this.capacity(intention, effRes);
  }

  grant(
    resolve: (p: Permit) => void,
    onAcquire: (() => void) | undefined,
    weight: number,
    intention: string,
  ): void {
    this.active += weight;
    this.activeByIntention[intention] = (this.activeByIntention[intention] ?? 0) + weight;
    onAcquire?.();
    this.assertInvariants();
    this.onEmitStats();
    let released = false;
    resolve({
      release: () => {
        if (released) return;
        released = true;
        this.releasePermit(weight, intention);
      },
    });
  }

  /** Enqueue a waiter. Returns true if enqueued, false if queue is full. */
  enqueue(waiter: Waiter): boolean {
    if (this.waiters.length >= this.maxQueueDepth) return false;
    this.waiters.push(waiter);
    this.queuedByIntention[waiter.intention] = (this.queuedByIntention[waiter.intention] ?? 0) + 1;
    return true;
  }

  removeWaiter(w: Waiter): void {
    const i = this.waiters.indexOf(w);
    if (i >= 0) {
      this.waiters.splice(i, 1);
      this.queuedByIntention[w.intention] = Math.max(
        0,
        (this.queuedByIntention[w.intention] ?? 0) - 1,
      );
      this.assertInvariants();
      this.onEmitStats();
    }
  }

  drainWaiters(): void {
    if (this.waiters.length === 0) return;
    const remaining: Waiter[] = [];
    for (const next of this.waiters) {
      if (!this.canGrant(next.intention, next.weight)) {
        remaining.push(next);
        continue;
      }
      this.queuedByIntention[next.intention] = Math.max(
        0,
        (this.queuedByIntention[next.intention] ?? 0) - 1,
      );
      clearTimeout(next.timeout);
      this.grant(next.resolve, next.onAcquire, next.weight, next.intention);
    }
    this.waiters = remaining;
    this.assertInvariants();
  }

  getQueueTimeoutMs(): number {
    return this.queueTimeoutMs;
  }

  shutdown(): void {
    for (const t of this.cooldownTimers) clearTimeout(t);
    this.cooldownTimers.clear();
    this.releaseTimer = null;
    this.pendingReleases = [];
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

  private releasePermit(weight: number, intention: string): void {
    this.pendingReleases.push({ weight, intention });
    if (this.releaseTimer === null) {
      this.releaseTimer = setTimeout(() => {
        this.releaseTimer = null;
        const batch = this.pendingReleases;
        this.pendingReleases = [];
        for (const rel of batch) {
          this.active = Math.max(0, this.active - rel.weight);
          this.activeByIntention[rel.intention] = Math.max(
            0,
            (this.activeByIntention[rel.intention] ?? 0) - rel.weight,
          );
        }
        this.drainWaiters();
        this.assertInvariants();
        this.onEmitStats();
      }, this.releaseCooldownMs);
      this.cooldownTimers.add(this.releaseTimer);
    }
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
   *  intentions that have not yet been filled by active permits. */
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

  private assertInvariants(): void {
    if (!(SCALE <= this.limit && this.limit <= this.hardCap)) {
      log.warn(
        `[gate.ts] invariant violation: SCALE(${SCALE}) <= limit(${this.limit}) <= hardCap(${this.hardCap})`,
      );
    }
    if (!Number.isInteger(this.active)) {
      log.warn(`[gate.ts] invariant warning: active(${this.active}) is not an integer`);
    }
    if (!Number.isInteger(this.limit)) {
      log.warn(`[gate.ts] invariant warning: limit(${this.limit}) is not an integer`);
    }
    if (!Number.isInteger(this.hardCap)) {
      log.warn(`[gate.ts] invariant warning: hardCap(${this.hardCap}) is not an integer`);
    }
    if (this.active > this.hardCap) {
      const excess = (this.active - this.hardCap) / SCALE;
      log.warn(
        `[gate.ts] invariant warning: active(${this.active}) > hardCap(${this.hardCap}); transient over-cap by ${excess} (in-flight permits will drain)`,
      );
    }
    if (this.active < 0) {
      log.warn(`[gate.ts] invariant violation: active(${this.active}) < 0`);
    }
  }
}

// ---------------------------------------------------------------------------
// ConcurrencyGate — public API, composes Semaphore + CircuitBreaker.
// ---------------------------------------------------------------------------

export class ConcurrencyGate {
  private readonly semaphore: Semaphore;
  private readonly breaker: CircuitBreaker;
  private onStatsCb: (() => void) | null = null;

  constructor(opts: ConcurrencyGateOptions) {
    this.breaker = new CircuitBreaker(
      opts.breakerThreshold,
      opts.breakerWindowMs,
      opts.breakerCooldownMs,
    );
    this.semaphore = new Semaphore(opts, () => this.emitStats());
  }

  /** Hot-reload reconfigurable parameters. Does NOT affect the soft limit
   *  (which is driven by usage.onChange). Updates breaker/queue/cooldown. */
  reconfigure(opts: Partial<ConcurrencyGateOptions>): void {
    this.semaphore.reconfigure(opts);
    this.breaker.reconfigure({
      threshold: opts.breakerThreshold,
      windowMs: opts.breakerWindowMs,
      cooldownMs: opts.breakerCooldownMs,
    });
    this.emitStats();
  }

  onStatsChange(cb: () => void): void {
    this.onStatsCb = cb;
  }

  getLimit(): number {
    return this.semaphore.getLimit() / SCALE;
  }

  getIntentionActive(intention: string): number {
    return this.semaphore.getIntentionActive(intention);
  }

  getIntentionQueued(intention: string): number {
    return this.semaphore.getIntentionQueued(intention);
  }

  resize(newLimit: number): void {
    if (this.semaphore.resize(newLimit)) {
      this.emitStats();
    }
  }

  /** Update the hard cap (e.g. from /v1/usage reconciliation).
   *  Clamps the soft limit down if it now exceeds the new hard cap.
   *
   *  Policy: `hard_cap` is a hard grant boundary, NOT a hard real-time ceiling.
   *  Lowering the cap does NOT evict active permits. Transient over-cap states
   *  are expected until in-flight permits complete naturally. */
  setHardCap(newHardCap: number): void {
    if (this.semaphore.setHardCap(newHardCap)) {
      this.emitStats();
    }
  }

  /** Update the persisted soft limit (from /v1/usage). Does NOT change the
   *  effective limit — that's driven by usage.onChange with priorityLow adjustment. */
  setSoftLimit(newSoftLimit: number): void {
    if (this.semaphore.setSoftLimit(newSoftLimit)) {
      this.emitStats();
    }
  }

  acquire(
    opts: {
      weight?: number;
      signal?: AbortSignal;
      onAcquire?: () => void;
      intention?: string;
    } = {},
  ): Promise<Permit> {
    const weight = Math.round((opts.weight ?? 1) * SCALE);
    if (weight <= 0) {
      throw new GateError("invalid_weight", "weight must be positive");
    }
    const intention = opts.intention ?? "main";
    return new Promise((resolve, reject) => {
      // Circuit breaker check
      if (this.breaker.maybeHalfOpen() === "open") {
        reject(new GateError("circuit_open", "Circuit breaker open"));
        return;
      }

      if (this.semaphore.canGrant(intention, weight)) {
        this.semaphore.grant(resolve, opts.onAcquire, weight, intention);
        return;
      }

      // Enqueue
      const queueTimeoutMs = this.semaphore.getQueueTimeoutMs();
      const timeout = setTimeout(() => {
        this.semaphore.removeWaiter(waiter);
        reject(new GateError("timeout", "Queue timeout exceeded"));
      }, queueTimeoutMs);

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

      if (!this.semaphore.enqueue(waiter)) {
        clearTimeout(timeout);
        reject(new GateError("queue_full", "Concurrency queue full"));
        return;
      }

      this.emitStats();

      opts.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timeout);
          this.semaphore.removeWaiter(waiter);
          reject(new GateError("aborted", "Client disconnected while enqueued"));
        },
        { once: true },
      );
    });
  }

  record429(type: "concurrency" | "rate_limit" | "gateway"): void {
    this.breaker.record429(type);
    if (this.breaker.getState() === "open") {
      this.emitStats();
    }
  }

  recordSuccess(): void {
    const wasHalfOpen = this.breaker.getState() === "half_open";
    this.breaker.recordSuccess();
    if (wasHalfOpen) {
      this.emitStats();
    }
  }

  getStats(snapshot: UsageSnapshot): GateStats {
    const now = Date.now();
    const boxed = snapshot.boxedUntil !== null && snapshot.boxedUntil > now;
    const activeByIntention: Record<string, number> = {};
    const semActive = this.semaphore.getActiveByIntention();
    for (const k of Object.keys(semActive)) {
      activeByIntention[k] = semActive[k] / SCALE;
    }
    const reservations: Record<string, number> = {};
    const semRes = this.semaphore.getReservations();
    for (const k of Object.keys(semRes)) {
      reservations[k] = semRes[k] / SCALE;
    }
    return {
      active: this.semaphore.getActive() / SCALE,
      queued: this.semaphore.getWaiterCount(),
      softLimit: this.semaphore.getSoftLimit() / SCALE,
      hardCap: this.semaphore.getHardCap() / SCALE,
      tier: snapshot.plan,
      breaker: this.breaker.getState(),
      boxed,
      boxedReason: snapshot.boxedReason,
      boxedUntil: snapshot.boxedUntil,
      priorityLow: snapshot.priorityLow,
      unitsDemoted: snapshot.unitsDemoted,
      demotedUntil: snapshot.demotedUntil,
      requestsRemaining: snapshot.requestsRemaining,
      requestsInWindow: snapshot.requestsInWindow,
      requestsLimit: snapshot.requestsLimit,
      windowSeconds: snapshot.requestsWindowSeconds,
      usageOk: snapshot.ok,
      lastUsageFetch: snapshot.fetchedAt || null,
      activeByIntention,
      queuedByIntention: { ...this.semaphore.getQueuedByIntention() },
      reservations,
      serviceMode: snapshot.serviceMode,
    };
  }

  shutdown(): void {
    this.semaphore.shutdown();
  }

  private emitStats(): void {
    this.onStatsCb?.();
  }
}
