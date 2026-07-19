// UsageHistoryStore — persists coalesced /v1/usage snapshots to usage_samples.
//
// SRP: this module owns only persistent usage history. It subscribes to
// UmansUsageClient.onChange() (DIP: depends on the callback interface, not on
// the aggregator's internals) and writes a row when the ambient snapshot body
// differs from the last-written sample.

import type { Database } from "bun:sqlite";
import { createLogger } from "../logger.js";
import type { UsageSnapshot } from "../types.js";
import { migrateUsageHistorySchema } from "./schema.js";

const log = createLogger("usage-history");

export interface UsageSampleRow {
  id: number;
  fetched_at: number;
  ok: number;
  user_id: string | null;
  plan: string;
  plan_slug: string | null;
  requests_limit: number | null;
  requests_hard_cap: number | null;
  requests_window_seconds: number | null;
  concurrency_soft_limit: number;
  concurrency_hard_cap: number;
  requests_in_window: number;
  weighted_requests_in_window: number;
  requests_remaining: number | null;
  weighted_remaining_requests: number | null;
  concurrent_sessions: number;
  weighted_concurrent_sessions: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  window_started_at: number | null;
  window_resets_at: number | null;
  window_remaining_minutes: number | null;
  priority_low: number;
  boxed_until: number | null;
  boxed_reason: string | null;
  units_demoted: number;
  demoted_until: number | null;
  service_mode_current: string;
  service_mode_resets_at: number | null;
}

/** Canonical ambient-comparison key: all snapshot fields except fetched_at.
 *  Two snapshots with the same key are byte-for-byte identical ambient state. */
function ambientKey(s: UsageSnapshot): string {
  return JSON.stringify({
    ok: s.ok,
    userId: s.userId,
    plan: s.plan,
    planSlug: s.planSlug,
    requestsLimit: s.requestsLimit,
    requestsHardCap: s.requestsHardCap,
    requestsWindowSeconds: s.requestsWindowSeconds,
    concurrencySoftLimit: s.concurrencySoftLimit,
    concurrencyHardCap: s.concurrencyHardCap,
    requestsInWindow: s.requestsInWindow,
    weightedRequestsInWindow: s.weightedRequestsInWindow,
    requestsRemaining: s.requestsRemaining,
    weightedRemainingRequests: s.weightedRemainingRequests,
    concurrentSessions: s.concurrentSessions,
    weightedConcurrentSessions: s.weightedConcurrentSessions,
    tokensIn: s.tokensIn,
    tokensOut: s.tokensOut,
    tokensCached: s.tokensCached,
    windowStartedAt: s.windowStartedAt,
    windowResetsAt: s.windowResetsAt,
    windowRemainingMinutes: s.windowRemainingMinutes,
    priorityLow: s.priorityLow,
    boxedUntil: s.boxedUntil,
    boxedReason: s.boxedReason,
    unitsDemoted: s.unitsDemoted,
    demotedUntil: s.demotedUntil,
    serviceMode: s.serviceMode,
  });
}

export interface UsageHistoryStoreOptions {
  db: Database;
}

export class UsageHistoryStore {
  private readonly db: Database;
  private readonly stmtInsert: ReturnType<Database["prepare"]>;
  private readonly stmtLast: ReturnType<Database["prepare"]>;
  private lastKey: string | null = null;

  constructor(opts: UsageHistoryStoreOptions) {
    this.db = opts.db;
    migrateUsageHistorySchema(this.db);
    this.stmtInsert = this.db.prepare(
      `INSERT INTO usage_samples (
        fetched_at, ok, user_id, plan, plan_slug,
        requests_limit, requests_hard_cap, requests_window_seconds,
        concurrency_soft_limit, concurrency_hard_cap,
        requests_in_window, weighted_requests_in_window,
        requests_remaining, weighted_remaining_requests,
        concurrent_sessions, weighted_concurrent_sessions,
        tokens_in, tokens_out, tokens_cached,
        window_started_at, window_resets_at, window_remaining_minutes,
        priority_low, boxed_until, boxed_reason,
        units_demoted, demoted_until,
        service_mode_current, service_mode_resets_at
      ) VALUES (
        $fetched_at, $ok, $user_id, $plan, $plan_slug,
        $requests_limit, $requests_hard_cap, $requests_window_seconds,
        $concurrency_soft_limit, $concurrency_hard_cap,
        $requests_in_window, $weighted_requests_in_window,
        $requests_remaining, $weighted_remaining_requests,
        $concurrent_sessions, $weighted_concurrent_sessions,
        $tokens_in, $tokens_out, $tokens_cached,
        $window_started_at, $window_resets_at, $window_remaining_minutes,
        $priority_low, $boxed_until, $boxed_reason,
        $units_demoted, $demoted_until,
        $service_mode_current, $service_mode_resets_at
      )`,
    );
    this.stmtLast = this.db.prepare("SELECT * FROM usage_samples ORDER BY id DESC LIMIT 1");
    // Seed the in-memory last-key from the most-recent row so that a restart
    // does not produce a duplicate sample for an unchanged upstream.
    const last = this.stmtLast.get() as UsageSampleRow | null;
    if (last) {
      this.lastKey = ambientKey({
        ok: last.ok === 1,
        fetchedAt: last.fetched_at,
        userId: last.user_id,
        plan: last.plan as UsageSnapshot["plan"],
        planSlug: last.plan_slug,
        requestsLimit: last.requests_limit,
        requestsHardCap: last.requests_hard_cap,
        requestsWindowSeconds: last.requests_window_seconds,
        concurrencySoftLimit: last.concurrency_soft_limit,
        concurrencyHardCap: last.concurrency_hard_cap,
        requestsInWindow: last.requests_in_window,
        weightedRequestsInWindow: last.weighted_requests_in_window,
        requestsRemaining: last.requests_remaining,
        weightedRemainingRequests: last.weighted_remaining_requests,
        concurrentSessions: last.concurrent_sessions,
        weightedConcurrentSessions: last.weighted_concurrent_sessions,
        tokensIn: last.tokens_in,
        tokensOut: last.tokens_out,
        tokensCached: last.tokens_cached,
        windowStartedAt: last.window_started_at,
        windowResetsAt: last.window_resets_at,
        windowRemainingMinutes: last.window_remaining_minutes,
        priorityLow: last.priority_low === 1,
        boxedUntil: last.boxed_until,
        boxedReason: last.boxed_reason,
        unitsDemoted: last.units_demoted === 1,
        demotedUntil: last.demoted_until,
        serviceMode: {
          current: last.service_mode_current,
          resetsAt: last.service_mode_resets_at,
        },
      });
    }
  }

  /** Subscribe hook — call on every UmansUsageClient onChange fire. */
  handleSnapshot(snap: UsageSnapshot): void {
    // Only coalesce successful snapshots — failed ones are ambient state
    // changes the user may want to see, but the ticket specifies coalescing
    // on ok=true. First-ever sample always writes.
    if (!snap.ok) return;
    const key = ambientKey(snap);
    if (this.lastKey !== null && this.lastKey === key) {
      return;
    }
    this.lastKey = key;
    this.stmtInsert.run({
      $fetched_at: snap.fetchedAt,
      $ok: snap.ok ? 1 : 0,
      $user_id: snap.userId,
      $plan: snap.plan,
      $plan_slug: snap.planSlug,
      $requests_limit: snap.requestsLimit,
      $requests_hard_cap: snap.requestsHardCap,
      $requests_window_seconds: snap.requestsWindowSeconds,
      $concurrency_soft_limit: snap.concurrencySoftLimit,
      $concurrency_hard_cap: snap.concurrencyHardCap,
      $requests_in_window: snap.requestsInWindow,
      $weighted_requests_in_window: snap.weightedRequestsInWindow,
      $requests_remaining: snap.requestsRemaining,
      $weighted_remaining_requests: snap.weightedRemainingRequests,
      $concurrent_sessions: snap.concurrentSessions,
      $weighted_concurrent_sessions: snap.weightedConcurrentSessions,
      $tokens_in: snap.tokensIn,
      $tokens_out: snap.tokensOut,
      $tokens_cached: snap.tokensCached,
      $window_started_at: snap.windowStartedAt,
      $window_resets_at: snap.windowResetsAt,
      $window_remaining_minutes: snap.windowRemainingMinutes,
      $priority_low: snap.priorityLow ? 1 : 0,
      $boxed_until: snap.boxedUntil,
      $boxed_reason: snap.boxedReason,
      $units_demoted: snap.unitsDemoted ? 1 : 0,
      $demoted_until: snap.demotedUntil,
      $service_mode_current: snap.serviceMode.current,
      $service_mode_resets_at: snap.serviceMode.resetsAt,
    });
    log.info(`wrote usage sample at ${snap.fetchedAt}`);
  }

  /** Return samples for a UTC day (YYYY-MM-DD). Most-recent-first. */
  getSamplesForDate(date: string): UsageSampleRow[] {
    const startMs = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isNaN(startMs)) return [];
    const endMs = startMs + 24 * 60 * 60 * 1000;
    return this.db
      .prepare(
        `SELECT * FROM usage_samples
         WHERE fetched_at >= $start AND fetched_at < $end
         ORDER BY id DESC`,
      )
      .all({ $start: startMs, $end: endMs }) as UsageSampleRow[];
  }
}
