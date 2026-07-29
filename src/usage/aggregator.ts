// UmansUsageClient — accumulates /v1/usage snapshots with periodic refresh.
// Owns mutable state (snapshot, timer, fetching flag) and the onChange callback.
// Delegates parsing to ./parser.js and one-shot limit fetches to ./reconciler.js.

import { createLogger } from "../logger.js";
import type { ProxyConfig, UsageSnapshot } from "../types.js";
import { fetchUsageRaw, type RawUsage } from "./fetch-usage.js";
import { buildSnapshot, failSafeSnapshot } from "./parser.js";
import { fetchConcurrencyLimits, fetchRequestsLimits } from "./reconciler.js";

const log = createLogger("usage");

export class UmansUsageClient {
  private snapshot: UsageSnapshot | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetching = false;
  private readonly target: string;
  private readonly apiKey: string | null;
  private readonly refreshMs: number;
  private onChangeCbs: Array<(s: UsageSnapshot) => void> = [];

  constructor(config: Pick<ProxyConfig, "target" | "umansApiKey" | "usageRefreshMs">) {
    this.target = config.target.replace(/\/+$/, "");
    this.apiKey = config.umansApiKey;
    this.refreshMs = config.usageRefreshMs;
  }

  onChange(cb: (s: UsageSnapshot) => void): void {
    this.onChangeCbs.push(cb);
  }

  start(): void {
    if (!this.apiKey || this.timer) return;
    void this.refresh();
    this.timer = setInterval(() => void this.refresh(), this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  getSnapshot(): UsageSnapshot {
    if (this.snapshot) return this.snapshot;
    return failSafeSnapshot();
  }

  async refresh(): Promise<void> {
    if (this.fetching || !this.apiKey) return;
    this.fetching = true;
    try {
      const result = await fetchUsageRaw(this.target, this.apiKey);
      if (!result.ok) {
        this.applyFailedSnapshot(result.error);
        return;
      }
      this.applySnapshot(result.data, true);
    } finally {
      this.fetching = false;
    }
  }

  /** One-shot fetch of /v1/usage to extract concurrency hard_cap + soft_limit.
   *  Does NOT update live snapshot. */
  async fetchLimitsFromSource(): Promise<
    { ok: true; hardCap: number; softLimit: number } | { ok: false; error: string }
  > {
    return fetchConcurrencyLimits(this.target, this.apiKey);
  }

  /** One-shot fetch of /v1/usage to extract requests limits for rate_limit_requests validation.
   *  Returns {limit, hardCap, windowSeconds} or null if not set (unlimited). */
  async fetchRequestsLimit(): Promise<
    | { ok: true; limit: number | null; hardCap: number | null; windowSeconds: number | null }
    | { ok: false; error: string }
  > {
    return fetchRequestsLimits(this.target, this.apiKey);
  }

  private applySnapshot(raw: RawUsage, ok: boolean): void {
    const lastHardCap = this.snapshot?.concurrencyHardCap ?? 1;
    const lastSoftLimit = this.snapshot?.concurrencySoftLimit ?? 1;
    const snap = buildSnapshot(raw, ok, lastHardCap, lastSoftLimit);
    this.snapshot = snap;
    for (const cb of this.onChangeCbs) {
      try {
        cb(snap);
      } catch (err) {
        log.error(`onChange callback failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  private applyFailedSnapshot(reason: string): void {
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, ok: false, fetchedAt: Date.now(), priorityLow: false };
      for (const cb of this.onChangeCbs) {
        try {
          cb(this.snapshot);
        } catch (err) {
          log.error(
            `onChange callback failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }
    // First fetch with no prior snapshot: skip onChange. failSafeSnapshot has
    // concurrencySoftLimit:1 — firing it would stamp the gate to 1 permanently.
    // getSnapshot() still returns the fail-safe for direct read queries.
    log.error(`fetch failed: ${reason}`);
  }
}
