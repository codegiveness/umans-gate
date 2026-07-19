// UsageHistoryStore — persists coalesced /v1/usage snapshots to usage_samples
// and composite tuple transitions to usage_events.
//
// SRP: this module owns only persistent usage history. It subscribes to
// UmansUsageClient.onChange() (DIP: depends on the callback interface, not on
// the aggregator's internals) and writes a sample row when the ambient snapshot
// body differs from the last-written sample, plus an event row when a
// priority or service_mode tuple transition is reported by the detector.

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

/** One composite tuple transition row (ticket 02). Carries full ambient
 *  context at the moment of transition per decision 05. */
export interface UsageEventRow {
  id: number;
  onset_at: number;
  transition: "onset" | "resolved" | "morph";
  tuple_kind: "priority" | "service_mode";
  previous_event_id: number | null;
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
  cache_hit_rate: number | null;
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

/** One row per UTC day (ticket 03). Per decision 08: two-snapshot model
 *  (trigger-moment + day-total) + two-dimension activity. */
export interface UsageDailyRow {
  day_utc: string;
  day_completeness: string;
  first_activity_utc: number | null;
  last_activity_utc: number | null;
  accumulated_active_minutes: number | null;
  utc_clock_span_minutes: number | null;
  first_activity_utc_hour: number | null;
  last_activity_utc_hour: number | null;
  active_minutes_by_utc_hour: string | null;
  tokens_in_total: number | null;
  tokens_out_total: number | null;
  tokens_cached_total: number | null;
  requests_in_window_peak: number | null;
  requests_in_window_avg: number | null;
  cache_hit_rate_avg: number | null;
  concurrent_sessions_peak: number | null;
  concurrent_sessions_avg: number | null;
  weighted_concurrent_sessions_peak: number | null;
  weighted_concurrent_sessions_avg: number | null;
  at_first_priority_event_concurrent_sessions: number | null;
  at_first_priority_event_weighted_concurrent_sessions: number | null;
  at_first_priority_event_requests_in_window: number | null;
  at_first_priority_event_weighted_requests_in_window: number | null;
  at_first_priority_event_requests_remaining: number | null;
  at_first_priority_event_requests_limit: number | null;
  at_first_priority_event_tokens_in: number | null;
  at_first_priority_event_tokens_out: number | null;
  at_first_priority_event_tokens_cached: number | null;
  at_first_priority_event_cache_hit_rate: number | null;
  at_first_service_mode_event_concurrent_sessions: number | null;
  at_first_service_mode_event_weighted_concurrent_sessions: number | null;
  at_first_service_mode_event_requests_in_window: number | null;
  at_first_service_mode_event_weighted_requests_in_window: number | null;
  at_first_service_mode_event_requests_remaining: number | null;
  at_first_service_mode_event_requests_limit: number | null;
  at_first_service_mode_event_tokens_in: number | null;
  at_first_service_mode_event_tokens_out: number | null;
  at_first_service_mode_event_tokens_cached: number | null;
  at_first_service_mode_event_cache_hit_rate: number | null;
  priority_low_minutes: number | null;
  boxed_minutes: number | null;
  units_demoted_minutes: number | null;
  service_mode_non_normal_minutes: number | null;
  priority_events_count: number | null;
  service_mode_events_count: number | null;
  priority_ban_total_duration_ms: number | null;
  service_mode_ban_total_duration_ms: number | null;
  concurrency_hard_cap: number | null;
  requests_limit: number | null;
  requests_hard_cap: number | null;
  downsampled_at: number;
}

/** Discriminated inputs for recordEvent (OCP: new tuple kinds add a new
 *  variant, they don't branch existing logic). */
export type EventTransition = "onset" | "resolved" | "morph";
export type TupleKind = "priority" | "service_mode";

export interface RecordEventInput {
  snap: UsageSnapshot;
  transition: EventTransition;
  tupleKind: TupleKind;
  /** Id of the open onset/morph this event closes (resolved/morph).
   *  NULL for onset. */
  previousEventId: number | null;
}

/** Derived cache hit rate per spec:
 *  cacheHitRate = tokensCached / (tokensIn + tokensOut + tokensCached).
 *  Null when the denominator is zero (no traffic to measure). */
export function deriveCacheHitRate(snap: UsageSnapshot): number | null {
  const denom = snap.tokensIn + snap.tokensOut + snap.tokensCached;
  if (denom === 0) return null;
  return snap.tokensCached / denom;
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
  private readonly stmtInsertEvent: ReturnType<Database["prepare"]>;
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
    this.stmtInsertEvent = this.db.prepare(
      `INSERT INTO usage_events (
        onset_at, transition, tuple_kind, previous_event_id,
        fetched_at, ok, user_id, plan, plan_slug,
        requests_limit, requests_hard_cap, requests_window_seconds,
        concurrency_soft_limit, concurrency_hard_cap,
        requests_in_window, weighted_requests_in_window,
        requests_remaining, weighted_remaining_requests,
        concurrent_sessions, weighted_concurrent_sessions,
        tokens_in, tokens_out, tokens_cached, cache_hit_rate,
        window_started_at, window_resets_at, window_remaining_minutes,
        priority_low, boxed_until, boxed_reason,
        units_demoted, demoted_until,
        service_mode_current, service_mode_resets_at
      ) VALUES (
        $onset_at, $transition, $tuple_kind, $previous_event_id,
        $fetched_at, $ok, $user_id, $plan, $plan_slug,
        $requests_limit, $requests_hard_cap, $requests_window_seconds,
        $concurrency_soft_limit, $concurrency_hard_cap,
        $requests_in_window, $weighted_requests_in_window,
        $requests_remaining, $weighted_remaining_requests,
        $concurrent_sessions, $weighted_concurrent_sessions,
        $tokens_in, $tokens_out, $tokens_cached, $cache_hit_rate,
        $window_started_at, $window_resets_at, $window_remaining_minutes,
        $priority_low, $boxed_until, $boxed_reason,
        $units_demoted, $demoted_until,
        $service_mode_current, $service_mode_resets_at
      )`,
    );
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

  /** Subscribe hook — call on every UmansUsageClient onChange fire.
   *  Returns `true` when a new sample row was written, `false` when the
   *  snapshot was coalesced or skipped. The return value lets the caller
   *  fire a WS dirty-notification only on actual writes (ticket 07). */
  handleSnapshot(snap: UsageSnapshot): boolean {
    // Only coalesce successful snapshots — failed ones are ambient state
    // changes the user may want to see, but the ticket specifies coalescing
    // on ok=true. First-ever sample always writes.
    if (!snap.ok) return false;
    const key = ambientKey(snap);
    if (this.lastKey !== null && this.lastKey === key) {
      return false;
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
    return true;
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

  /** Persist a composite tuple transition event row.
   *  Returns the inserted row id so the detector can chain previous_event_id. */
  recordEvent(input: RecordEventInput): number {
    const { snap, transition, tupleKind, previousEventId } = input;
    const cacheHitRate = deriveCacheHitRate(snap);
    const info = this.stmtInsertEvent.run({
      $onset_at: snap.fetchedAt,
      $transition: transition,
      $tuple_kind: tupleKind,
      $previous_event_id: previousEventId,
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
      $cache_hit_rate: cacheHitRate,
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
    const id = Number(info.lastInsertRowid);
    log.info(`wrote usage event id=${id} ${tupleKind}/${transition} at ${snap.fetchedAt}`);
    return id;
  }

  /** Return the most recent event of a given tuple_kind that is still "open"
   *  (i.e. has no resolved/morph row pointing at it via previous_event_id).
   *  Used by the detector to chain previous_event_id on resolved/morph transitions. */
  getOpenEventForTuple(tupleKind: TupleKind): UsageEventRow | null {
    const row = this.db
      .prepare(
        `SELECT e.* FROM usage_events e
         WHERE e.tuple_kind = $kind
           AND e.id NOT IN (
             SELECT previous_event_id FROM usage_events
             WHERE previous_event_id IS NOT NULL
           )
         ORDER BY e.id DESC
         LIMIT 1`,
      )
      .get({ $kind: tupleKind }) as UsageEventRow | null;
    return row ?? null;
  }

  /** Return events for a UTC day (YYYY-MM-DD). Most-recent-first. */
  getEventsForDate(date: string): UsageEventRow[] {
    const startMs = Date.parse(`${date}T00:00:00.000Z`);
    if (Number.isNaN(startMs)) return [];
    const endMs = startMs + 24 * 60 * 60 * 1000;
    return this.db
      .prepare(
        `SELECT * FROM usage_events
         WHERE onset_at >= $start AND onset_at < $end
         ORDER BY id DESC`,
      )
      .all({ $start: startMs, $end: endMs }) as UsageEventRow[];
  }

  /** Return samples for a UTC-day range [from, to] inclusive. Ascending by fetched_at. */
  getSampleRange(from: string, to: string): UsageSampleRow[] {
    const startMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`);
    if (Number.isNaN(startMs) || Number.isNaN(toMs)) return [];
    const endMs = toMs + 24 * 60 * 60 * 1000;
    return this.db
      .prepare(
        `SELECT * FROM usage_samples
         WHERE fetched_at >= $start AND fetched_at < $end
         ORDER BY fetched_at ASC`,
      )
      .all({ $start: startMs, $end: endMs }) as UsageSampleRow[];
  }

  /** Return events for a UTC-day range [from, to] inclusive. Ascending by onset_at. */
  getEventsForDateRange(from: string, to: string): UsageEventRow[] {
    const startMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`);
    if (Number.isNaN(startMs) || Number.isNaN(toMs)) return [];
    const endMs = toMs + 24 * 60 * 60 * 1000;
    return this.db
      .prepare(
        `SELECT * FROM usage_events
         WHERE onset_at >= $start AND onset_at < $end
         ORDER BY onset_at ASC`,
      )
      .all({ $start: startMs, $end: endMs }) as UsageEventRow[];
  }

  /** Return daily aggregates for a UTC-day range [from, to] inclusive. Ascending by day_utc. */
  getDailyRange(from: string, to: string): UsageDailyRow[] {
    return this.db
      .prepare(
        `SELECT * FROM usage_daily
         WHERE day_utc >= $from AND day_utc <= $to
         ORDER BY day_utc ASC`,
      )
      .all({ $from: from, $to: to }) as UsageDailyRow[];
  }

  /** Return a single daily row by UTC date (YYYY-MM-DD), or null. */
  getDailyRow(dayUtc: string): UsageDailyRow | null {
    const row = this.db
      .prepare("SELECT * FROM usage_daily WHERE day_utc = $day")
      .get({ $day: dayUtc }) as UsageDailyRow | null;
    return row ?? null;
  }

  /** Insert or replace a daily aggregate row. Idempotent by day_utc PK. */
  upsertDailyRow(row: UsageDailyRow): void {
    const bindings: Record<string, string | number | null> = {
      $day_utc: row.day_utc,
      $day_completeness: row.day_completeness,
      $first_activity_utc: row.first_activity_utc,
      $last_activity_utc: row.last_activity_utc,
      $accumulated_active_minutes: row.accumulated_active_minutes,
      $utc_clock_span_minutes: row.utc_clock_span_minutes,
      $first_activity_utc_hour: row.first_activity_utc_hour,
      $last_activity_utc_hour: row.last_activity_utc_hour,
      $active_minutes_by_utc_hour: row.active_minutes_by_utc_hour,
      $tokens_in_total: row.tokens_in_total,
      $tokens_out_total: row.tokens_out_total,
      $tokens_cached_total: row.tokens_cached_total,
      $requests_in_window_peak: row.requests_in_window_peak,
      $requests_in_window_avg: row.requests_in_window_avg,
      $cache_hit_rate_avg: row.cache_hit_rate_avg,
      $concurrent_sessions_peak: row.concurrent_sessions_peak,
      $concurrent_sessions_avg: row.concurrent_sessions_avg,
      $weighted_concurrent_sessions_peak: row.weighted_concurrent_sessions_peak,
      $weighted_concurrent_sessions_avg: row.weighted_concurrent_sessions_avg,
      $at_first_priority_event_concurrent_sessions: row.at_first_priority_event_concurrent_sessions,
      $at_first_priority_event_weighted_concurrent_sessions:
        row.at_first_priority_event_weighted_concurrent_sessions,
      $at_first_priority_event_requests_in_window: row.at_first_priority_event_requests_in_window,
      $at_first_priority_event_weighted_requests_in_window:
        row.at_first_priority_event_weighted_requests_in_window,
      $at_first_priority_event_requests_remaining: row.at_first_priority_event_requests_remaining,
      $at_first_priority_event_requests_limit: row.at_first_priority_event_requests_limit,
      $at_first_priority_event_tokens_in: row.at_first_priority_event_tokens_in,
      $at_first_priority_event_tokens_out: row.at_first_priority_event_tokens_out,
      $at_first_priority_event_tokens_cached: row.at_first_priority_event_tokens_cached,
      $at_first_priority_event_cache_hit_rate: row.at_first_priority_event_cache_hit_rate,
      $at_first_service_mode_event_concurrent_sessions:
        row.at_first_service_mode_event_concurrent_sessions,
      $at_first_service_mode_event_weighted_concurrent_sessions:
        row.at_first_service_mode_event_weighted_concurrent_sessions,
      $at_first_service_mode_event_requests_in_window:
        row.at_first_service_mode_event_requests_in_window,
      $at_first_service_mode_event_weighted_requests_in_window:
        row.at_first_service_mode_event_weighted_requests_in_window,
      $at_first_service_mode_event_requests_remaining:
        row.at_first_service_mode_event_requests_remaining,
      $at_first_service_mode_event_requests_limit: row.at_first_service_mode_event_requests_limit,
      $at_first_service_mode_event_tokens_in: row.at_first_service_mode_event_tokens_in,
      $at_first_service_mode_event_tokens_out: row.at_first_service_mode_event_tokens_out,
      $at_first_service_mode_event_tokens_cached: row.at_first_service_mode_event_tokens_cached,
      $at_first_service_mode_event_cache_hit_rate: row.at_first_service_mode_event_cache_hit_rate,
      $priority_low_minutes: row.priority_low_minutes,
      $boxed_minutes: row.boxed_minutes,
      $units_demoted_minutes: row.units_demoted_minutes,
      $service_mode_non_normal_minutes: row.service_mode_non_normal_minutes,
      $priority_events_count: row.priority_events_count,
      $service_mode_events_count: row.service_mode_events_count,
      $priority_ban_total_duration_ms: row.priority_ban_total_duration_ms,
      $service_mode_ban_total_duration_ms: row.service_mode_ban_total_duration_ms,
      $concurrency_hard_cap: row.concurrency_hard_cap,
      $requests_limit: row.requests_limit,
      $requests_hard_cap: row.requests_hard_cap,
      $downsampled_at: row.downsampled_at,
    };
    this.db
      .prepare(
        `INSERT OR REPLACE INTO usage_daily (
          day_utc, day_completeness,
          first_activity_utc, last_activity_utc,
          accumulated_active_minutes, utc_clock_span_minutes,
          first_activity_utc_hour, last_activity_utc_hour,
          active_minutes_by_utc_hour,
          tokens_in_total, tokens_out_total, tokens_cached_total,
          requests_in_window_peak, requests_in_window_avg,
          cache_hit_rate_avg,
          concurrent_sessions_peak, concurrent_sessions_avg,
          weighted_concurrent_sessions_peak, weighted_concurrent_sessions_avg,
          at_first_priority_event_concurrent_sessions,
          at_first_priority_event_weighted_concurrent_sessions,
          at_first_priority_event_requests_in_window,
          at_first_priority_event_weighted_requests_in_window,
          at_first_priority_event_requests_remaining,
          at_first_priority_event_requests_limit,
          at_first_priority_event_tokens_in,
          at_first_priority_event_tokens_out,
          at_first_priority_event_tokens_cached,
          at_first_priority_event_cache_hit_rate,
          at_first_service_mode_event_concurrent_sessions,
          at_first_service_mode_event_weighted_concurrent_sessions,
          at_first_service_mode_event_requests_in_window,
          at_first_service_mode_event_weighted_requests_in_window,
          at_first_service_mode_event_requests_remaining,
          at_first_service_mode_event_requests_limit,
          at_first_service_mode_event_tokens_in,
          at_first_service_mode_event_tokens_out,
          at_first_service_mode_event_tokens_cached,
          at_first_service_mode_event_cache_hit_rate,
          priority_low_minutes, boxed_minutes, units_demoted_minutes,
          service_mode_non_normal_minutes,
          priority_events_count, service_mode_events_count,
          priority_ban_total_duration_ms, service_mode_ban_total_duration_ms,
          concurrency_hard_cap, requests_limit, requests_hard_cap,
          downsampled_at
        ) VALUES (
          $day_utc, $day_completeness,
          $first_activity_utc, $last_activity_utc,
          $accumulated_active_minutes, $utc_clock_span_minutes,
          $first_activity_utc_hour, $last_activity_utc_hour,
          $active_minutes_by_utc_hour,
          $tokens_in_total, $tokens_out_total, $tokens_cached_total,
          $requests_in_window_peak, $requests_in_window_avg,
          $cache_hit_rate_avg,
          $concurrent_sessions_peak, $concurrent_sessions_avg,
          $weighted_concurrent_sessions_peak, $weighted_concurrent_sessions_avg,
          $at_first_priority_event_concurrent_sessions,
          $at_first_priority_event_weighted_concurrent_sessions,
          $at_first_priority_event_requests_in_window,
          $at_first_priority_event_weighted_requests_in_window,
          $at_first_priority_event_requests_remaining,
          $at_first_priority_event_requests_limit,
          $at_first_priority_event_tokens_in,
          $at_first_priority_event_tokens_out,
          $at_first_priority_event_tokens_cached,
          $at_first_priority_event_cache_hit_rate,
          $at_first_service_mode_event_concurrent_sessions,
          $at_first_service_mode_event_weighted_concurrent_sessions,
          $at_first_service_mode_event_requests_in_window,
          $at_first_service_mode_event_weighted_requests_in_window,
          $at_first_service_mode_event_requests_remaining,
          $at_first_service_mode_event_requests_limit,
          $at_first_service_mode_event_tokens_in,
          $at_first_service_mode_event_tokens_out,
          $at_first_service_mode_event_tokens_cached,
          $at_first_service_mode_event_cache_hit_rate,
          $priority_low_minutes, $boxed_minutes, $units_demoted_minutes,
          $service_mode_non_normal_minutes,
          $priority_events_count, $service_mode_events_count,
          $priority_ban_total_duration_ms, $service_mode_ban_total_duration_ms,
          $concurrency_hard_cap, $requests_limit, $requests_hard_cap,
          $downsampled_at
        )`,
      )
      .run(bindings);
  }

  /** Delete usage_samples rows in a UTC-day range [from, to] inclusive. */
  deleteSamplesInRange(from: string, to: string): number {
    const startMs = Date.parse(`${from}T00:00:00.000Z`);
    const toMs = Date.parse(`${to}T00:00:00.000Z`);
    if (Number.isNaN(startMs) || Number.isNaN(toMs)) return 0;
    const endMs = toMs + 24 * 60 * 60 * 1000;
    const info = this.db
      .prepare("DELETE FROM usage_samples WHERE fetched_at >= $start AND fetched_at < $end")
      .run({ $start: startMs, $end: endMs });
    return Number(info.changes);
  }

  /** Delete usage_samples rows older than cutoffMs (ms epoch). Returns deleted count. */
  deleteSamplesOlderThan(cutoffMs: number): number {
    const info = this.db
      .prepare("DELETE FROM usage_samples WHERE fetched_at < $cutoff")
      .run({ $cutoff: cutoffMs });
    return Number(info.changes);
  }

  /** Return distinct UTC days (YYYY-MM-DD) present in usage_samples older than cutoffMs. */
  getSampleDaysOlderThan(cutoffMs: number): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT strftime('%Y-%m-%d', fetched_at / 1000, 'unixepoch') AS day
         FROM usage_samples
         WHERE fetched_at < $cutoff AND day IS NOT NULL
         ORDER BY day ASC`,
      )
      .all({ $cutoff: cutoffMs }) as { day: string }[];
    return rows.map((r) => r.day);
  }
}
