// Daily downsampling job (ticket 03).
//
// SRP: this module owns ONLY the daily aggregation + pruning + missing-day
// backfill. It reads usage_samples + usage_events, computes one row per UTC
// day, and writes usage_daily. It never touches capture storage, the read
// path, or the onChange subscription (decisions 07–11).
//
// Trigger (decision 09): called once at startup, then on a UTC-midnight timer.
// Idempotent: "find days lacking a daily row" is safe to run repeatedly.

import { createLogger } from "../logger.js";
import type { UsageDailyRow, UsageEventRow, UsageHistoryStore, UsageSampleRow } from "./store.js";

const log = createLogger("usage-daily");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

export type DayCompleteness =
  | "full"
  | "partial_start"
  | "partial_end"
  | "partial_both"
  | "missing"
  | "incomplete_window";

export interface DownsampleOptions {
  /** Gap threshold in minutes (decision 11). */
  gapThresholdMinutes: number;
}

export interface DownsampleDayInput {
  store: UsageHistoryStore;
  dayUtc: string;
  gapThresholdMinutes: number;
}

/** Convert ms epoch to YYYY-MM-DD UTC. */
export function dayUtcOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Convert YYYY-MM-DD to ms epoch at UTC 00:00:00. */
export function utcMidnightMs(dayUtc: string): number {
  return Date.parse(`${dayUtc}T00:00:00.000Z`);
}

/** Add days to a YYYY-MM-DD string, returning a new YYYY-MM-DD. */
export function addDays(dayUtc: string, days: number): string {
  const ms = utcMidnightMs(dayUtc) + days * MS_PER_DAY;
  return dayUtcOf(ms);
}

/** Ambient comparison key (excluding fetched_at). Two samples with the same
 *  key are byte-identical ambient state — gap detection skips them. */
function ambientKey(s: UsageSampleRow): string {
  return JSON.stringify({
    ok: s.ok,
    user_id: s.user_id,
    plan: s.plan,
    plan_slug: s.plan_slug,
    requests_limit: s.requests_limit,
    requests_hard_cap: s.requests_hard_cap,
    requests_window_seconds: s.requests_window_seconds,
    concurrency_soft_limit: s.concurrency_soft_limit,
    concurrency_hard_cap: s.concurrency_hard_cap,
    requests_in_window: s.requests_in_window,
    weighted_requests_in_window: s.weighted_requests_in_window,
    requests_remaining: s.requests_remaining,
    weighted_remaining_requests: s.weighted_remaining_requests,
    concurrent_sessions: s.concurrent_sessions,
    weighted_concurrent_sessions: s.weighted_concurrent_sessions,
    tokens_in: s.tokens_in,
    tokens_out: s.tokens_out,
    tokens_cached: s.tokens_cached,
    window_started_at: s.window_started_at,
    window_resets_at: s.window_resets_at,
    window_remaining_minutes: s.window_remaining_minutes,
    priority_low: s.priority_low,
    boxed_until: s.boxed_until,
    boxed_reason: s.boxed_reason,
    units_demoted: s.units_demoted,
    demoted_until: s.demoted_until,
    service_mode_current: s.service_mode_current,
    service_mode_resets_at: s.service_mode_resets_at,
  });
}

/** Build the 10 trigger-moment fields from an event row. */
interface TriggerMomentFields {
  concurrent_sessions: number | null;
  weighted_concurrent_sessions: number | null;
  requests_in_window: number | null;
  weighted_requests_in_window: number | null;
  requests_remaining: number | null;
  requests_limit: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  tokens_cached: number | null;
  cache_hit_rate: number | null;
}

function triggerMomentFromEvent(ev: UsageEventRow): TriggerMomentFields {
  return {
    concurrent_sessions: ev.concurrent_sessions,
    weighted_concurrent_sessions: ev.weighted_concurrent_sessions,
    requests_in_window: ev.requests_in_window,
    weighted_requests_in_window: ev.weighted_requests_in_window,
    requests_remaining: ev.requests_remaining,
    requests_limit: ev.requests_limit,
    tokens_in: ev.tokens_in,
    tokens_out: ev.tokens_out,
    tokens_cached: ev.tokens_cached,
    cache_hit_rate: ev.cache_hit_rate,
  };
}

const NULL_TRIGGER: TriggerMomentFields = {
  concurrent_sessions: null,
  weighted_concurrent_sessions: null,
  requests_in_window: null,
  weighted_requests_in_window: null,
  requests_remaining: null,
  requests_limit: null,
  tokens_in: null,
  tokens_out: null,
  tokens_cached: null,
  cache_hit_rate: null,
};

/** Compute the daily aggregate row for one UTC day from samples + events.
 *  Does NOT persist; caller writes via store.upsertDailyRow(). */
export function computeDailyRow(input: DownsampleDayInput): UsageDailyRow {
  const { store, dayUtc, gapThresholdMinutes } = input;
  const startMs = utcMidnightMs(dayUtc);
  const endMs = startMs + MS_PER_DAY;
  const downsampledAt = Date.now();

  // Missing-day backfill: zero samples → NULL activity, completeness=missing.
  const samples = store
    .getSampleRange(dayUtc, dayUtc)
    .filter((s) => s.fetched_at >= startMs && s.fetched_at < endMs);

  const events = store
    .getEventsForDateRange(dayUtc, dayUtc)
    .filter((e) => e.onset_at >= startMs && e.onset_at < endMs);

  if (samples.length === 0) {
    const priorityEvents = events.filter((e) => e.tuple_kind === "priority").length;
    const serviceModeEvents = events.filter((e) => e.tuple_kind === "service_mode").length;
    return {
      day_utc: dayUtc,
      day_completeness: "missing",
      first_activity_utc: null,
      last_activity_utc: null,
      accumulated_active_minutes: null,
      utc_clock_span_minutes: null,
      first_activity_utc_hour: null,
      last_activity_utc_hour: null,
      active_minutes_by_utc_hour: null,
      tokens_in_total: null,
      tokens_out_total: null,
      tokens_cached_total: null,
      requests_in_window_peak: null,
      requests_in_window_avg: null,
      cache_hit_rate_avg: null,
      concurrent_sessions_peak: null,
      concurrent_sessions_avg: null,
      weighted_concurrent_sessions_peak: null,
      weighted_concurrent_sessions_avg: null,
      at_first_priority_event_concurrent_sessions: null,
      at_first_priority_event_weighted_concurrent_sessions: null,
      at_first_priority_event_requests_in_window: null,
      at_first_priority_event_weighted_requests_in_window: null,
      at_first_priority_event_requests_remaining: null,
      at_first_priority_event_requests_limit: null,
      at_first_priority_event_tokens_in: null,
      at_first_priority_event_tokens_out: null,
      at_first_priority_event_tokens_cached: null,
      at_first_priority_event_cache_hit_rate: null,
      at_first_service_mode_event_concurrent_sessions: null,
      at_first_service_mode_event_weighted_concurrent_sessions: null,
      at_first_service_mode_event_requests_in_window: null,
      at_first_service_mode_event_weighted_requests_in_window: null,
      at_first_service_mode_event_requests_remaining: null,
      at_first_service_mode_event_requests_limit: null,
      at_first_service_mode_event_tokens_in: null,
      at_first_service_mode_event_tokens_out: null,
      at_first_service_mode_event_tokens_cached: null,
      at_first_service_mode_event_cache_hit_rate: null,
      priority_low_minutes: 0,
      boxed_minutes: 0,
      units_demoted_minutes: 0,
      service_mode_non_normal_minutes: 0,
      priority_events_count: priorityEvents,
      service_mode_events_count: serviceModeEvents,
      priority_ban_total_duration_ms: 0,
      service_mode_ban_total_duration_ms: 0,
      concurrency_hard_cap: null,
      requests_limit: null,
      requests_hard_cap: null,
      downsampled_at: downsampledAt,
    };
  }

  // Samples ascending by fetched_at (getSampleRange already orders ASC).
  const first = samples[0];
  const last = samples[samples.length - 1];
  const firstHour = new Date(first.fetched_at).getUTCHours();
  const lastHour = new Date(last.fetched_at).getUTCHours();

  // Dimension A: accumulated active minutes. Sum of (next - prev) in minutes
  // for adjacent pairs where interval ≤ gapThresholdMinutes. Gaps excluded.
  // Also build active_minutes_by_utc_hour (24-bucket JSON).
  const hourBuckets = new Array<number>(24).fill(0);
  let accumulatedActiveMinutes = 0;
  let hasGap = false;
  const gapMs = gapThresholdMinutes * MS_PER_MINUTE;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const next = samples[i];
    const intervalMs = next.fetched_at - prev.fetched_at;
    const identical = ambientKey(prev) === ambientKey(next);
    if (intervalMs > gapMs && !identical) {
      hasGap = true;
      continue;
    }
    if (identical) {
      // Byte-identical adjacent pair — idle coalesce, not a gap, but also
      // not "active" time. Skip without contributing to active minutes.
      continue;
    }
    const intervalMin = intervalMs / MS_PER_MINUTE;
    accumulatedActiveMinutes += intervalMin;
    const bucketHour = new Date(prev.fetched_at).getUTCHours();
    hourBuckets[bucketHour] += intervalMin;
  }

  // Dimension B: UTC clock span.
  const utcClockSpanMinutes = (last.fetched_at - first.fetched_at) / MS_PER_MINUTE;

  // Day-total tokens (monotonic counters — take the last sample's value).
  const tokensInTotal = last.tokens_in;
  const tokensOutTotal = last.tokens_out;
  const tokensCachedTotal = last.tokens_cached;

  // Day-total gauges: peak + avg.
  const requestsInWindowValues = samples.map((s) => s.requests_in_window);
  const concurrentSessionsValues = samples.map((s) => s.concurrent_sessions);
  const weightedConcurrentSessionsValues = samples.map((s) => s.weighted_concurrent_sessions);
  const requestsInWindowPeak = Math.max(...requestsInWindowValues);
  const requestsInWindowAvg =
    requestsInWindowValues.reduce((a, b) => a + b, 0) / requestsInWindowValues.length;
  const concurrentSessionsPeak = Math.max(...concurrentSessionsValues);
  const concurrentSessionsAvg =
    concurrentSessionsValues.reduce((a, b) => a + b, 0) / concurrentSessionsValues.length;
  const weightedConcurrentSessionsPeak = Math.max(...weightedConcurrentSessionsValues);
  const weightedConcurrentSessionsAvg =
    weightedConcurrentSessionsValues.reduce((a, b) => a + b, 0) /
    weightedConcurrentSessionsValues.length;

  // Cache hit rate avg — derived per sample.
  const cacheHitRates = samples
    .map((s) => {
      const denom = s.tokens_in + s.tokens_out + s.tokens_cached;
      return denom === 0 ? null : s.tokens_cached / denom;
    })
    .filter((r): r is number => r !== null);
  const cacheHitRateAvg =
    cacheHitRates.length === 0
      ? null
      : cacheHitRates.reduce((a, b) => a + b, 0) / cacheHitRates.length;

  // Two-snapshot trigger-moment: first priority event + first service_mode event.
  const firstPriorityEvent = events.find((e) => e.tuple_kind === "priority");
  const firstServiceModeEvent = events.find((e) => e.tuple_kind === "service_mode");
  const priorityTrigger = firstPriorityEvent
    ? triggerMomentFromEvent(firstPriorityEvent)
    : NULL_TRIGGER;
  const serviceModeTrigger = firstServiceModeEvent
    ? triggerMomentFromEvent(firstServiceModeEvent)
    : NULL_TRIGGER;

  // Degradation burden — sum intervals where each flag was set.
  // Gap threshold does NOT apply here: if a flag was set on `prev`, the
  // degradation persists until the next sample shows it cleared, regardless
  // of how long the interval is. Byte-identical pairs still skip (idle).
  let priorityLowMinutes = 0;
  let boxedMinutes = 0;
  let unitsDemotedMinutes = 0;
  let serviceModeNonNormalMinutes = 0;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const next = samples[i];
    const intervalMs = next.fetched_at - prev.fetched_at;
    if (ambientKey(prev) === ambientKey(next)) continue;
    const intervalMin = intervalMs / MS_PER_MINUTE;
    if (prev.priority_low === 1) priorityLowMinutes += intervalMin;
    if (prev.boxed_until !== null && prev.boxed_until > prev.fetched_at) {
      boxedMinutes += intervalMin;
    }
    if (prev.units_demoted === 1) unitsDemotedMinutes += intervalMin;
    if (prev.service_mode_current !== "normal") serviceModeNonNormalMinutes += intervalMin;
  }

  const priorityEvents = events.filter((e) => e.tuple_kind === "priority");
  const serviceModeEvents = events.filter((e) => e.tuple_kind === "service_mode");

  // Ban total duration: sum of (resolved.onset_at - onset.onset_at) for each
  // resolved pair; for unresolved onsets, measure to min(boxed_until, end-of-day)
  // since the ban self-resolves at boxed_until.
  let priorityBanTotalMs = 0;
  let serviceModeBanTotalMs = 0;
  for (const kind of ["priority", "service_mode"] as const) {
    const evs = events.filter((e) => e.tuple_kind === kind);
    // Match onset → resolved/morph by previous_event_id chain.
    const onsets = evs.filter((e) => e.transition === "onset");
    for (const onset of onsets) {
      const closer = evs.find((e) => e.previous_event_id === onset.id);
      let endMs2: number;
      if (closer) {
        endMs2 = closer.onset_at;
      } else if (onset.boxed_until !== null && onset.boxed_until < endMs) {
        endMs2 = onset.boxed_until;
      } else {
        endMs2 = endMs;
      }
      const dur = endMs2 - onset.onset_at;
      if (dur > 0) {
        if (kind === "priority") priorityBanTotalMs += dur;
        else serviceModeBanTotalMs += dur;
      }
    }
  }

  // Static-for-day: from first sample.
  const concurrencyHardCap = first.concurrency_hard_cap;
  const requestsLimit = first.requests_limit;
  const requestsHardCap = first.requests_hard_cap;

  // Completeness precedence: missing > partial_both > partial_start/partial_end
  // > incomplete_window > full.
  let completeness: DayCompleteness;
  const partialStart = firstHour > 0;
  const partialEnd = lastHour < 23;
  if (partialStart && partialEnd) {
    completeness = "partial_both";
  } else if (partialStart) {
    completeness = "partial_start";
  } else if (partialEnd) {
    completeness = "partial_end";
  } else if (hasGap) {
    completeness = "incomplete_window";
  } else {
    completeness = "full";
  }

  // Active-minutes-by-hour JSON: only include non-zero buckets for compactness.
  const hourObj: Record<string, number> = {};
  for (let h = 0; h < 24; h++) {
    if (hourBuckets[h] > 0) {
      hourObj[String(h).padStart(2, "0")] = Math.round(hourBuckets[h] * 60) / 60;
    }
  }

  return {
    day_utc: dayUtc,
    day_completeness: completeness,
    first_activity_utc: first.fetched_at,
    last_activity_utc: last.fetched_at,
    accumulated_active_minutes: Math.round(accumulatedActiveMinutes),
    utc_clock_span_minutes: Math.round(utcClockSpanMinutes),
    first_activity_utc_hour: firstHour,
    last_activity_utc_hour: lastHour,
    active_minutes_by_utc_hour: JSON.stringify(hourObj),
    tokens_in_total: tokensInTotal,
    tokens_out_total: tokensOutTotal,
    tokens_cached_total: tokensCachedTotal,
    requests_in_window_peak: requestsInWindowPeak,
    requests_in_window_avg: requestsInWindowAvg,
    cache_hit_rate_avg: cacheHitRateAvg,
    concurrent_sessions_peak: concurrentSessionsPeak,
    concurrent_sessions_avg: concurrentSessionsAvg,
    weighted_concurrent_sessions_peak: weightedConcurrentSessionsPeak,
    weighted_concurrent_sessions_avg: weightedConcurrentSessionsAvg,
    at_first_priority_event_concurrent_sessions: priorityTrigger.concurrent_sessions,
    at_first_priority_event_weighted_concurrent_sessions:
      priorityTrigger.weighted_concurrent_sessions,
    at_first_priority_event_requests_in_window: priorityTrigger.requests_in_window,
    at_first_priority_event_weighted_requests_in_window:
      priorityTrigger.weighted_requests_in_window,
    at_first_priority_event_requests_remaining: priorityTrigger.requests_remaining,
    at_first_priority_event_requests_limit: priorityTrigger.requests_limit,
    at_first_priority_event_tokens_in: priorityTrigger.tokens_in,
    at_first_priority_event_tokens_out: priorityTrigger.tokens_out,
    at_first_priority_event_tokens_cached: priorityTrigger.tokens_cached,
    at_first_priority_event_cache_hit_rate: priorityTrigger.cache_hit_rate,
    at_first_service_mode_event_concurrent_sessions: serviceModeTrigger.concurrent_sessions,
    at_first_service_mode_event_weighted_concurrent_sessions:
      serviceModeTrigger.weighted_concurrent_sessions,
    at_first_service_mode_event_requests_in_window: serviceModeTrigger.requests_in_window,
    at_first_service_mode_event_weighted_requests_in_window:
      serviceModeTrigger.weighted_requests_in_window,
    at_first_service_mode_event_requests_remaining: serviceModeTrigger.requests_remaining,
    at_first_service_mode_event_requests_limit: serviceModeTrigger.requests_limit,
    at_first_service_mode_event_tokens_in: serviceModeTrigger.tokens_in,
    at_first_service_mode_event_tokens_out: serviceModeTrigger.tokens_out,
    at_first_service_mode_event_tokens_cached: serviceModeTrigger.tokens_cached,
    at_first_service_mode_event_cache_hit_rate: serviceModeTrigger.cache_hit_rate,
    priority_low_minutes: Math.round(priorityLowMinutes),
    boxed_minutes: Math.round(boxedMinutes),
    units_demoted_minutes: Math.round(unitsDemotedMinutes),
    service_mode_non_normal_minutes: Math.round(serviceModeNonNormalMinutes),
    priority_events_count: priorityEvents.length,
    service_mode_events_count: serviceModeEvents.length,
    priority_ban_total_duration_ms: priorityBanTotalMs,
    service_mode_ban_total_duration_ms: serviceModeBanTotalMs,
    concurrency_hard_cap: concurrencyHardCap,
    requests_limit: requestsLimit,
    requests_hard_cap: requestsHardCap,
    downsampled_at: downsampledAt,
  };
}

/** Downsample one UTC day: compute and upsert the daily row.
 *  Idempotent: safe to call repeatedly. Does NOT prune raw samples. */
export function downsampleDay(
  store: UsageHistoryStore,
  dayUtc: string,
  gapThresholdMinutes: number,
): UsageDailyRow {
  const row = computeDailyRow({ store, dayUtc, gapThresholdMinutes });
  store.upsertDailyRow(row);
  log.info(`downsampled ${dayUtc} → ${row.day_completeness}`);
  return row;
}

/** Downsample a UTC-day range [fromUtc, toUtc] inclusive.
 *  - For each day lacking a daily row, compute & upsert.
 *  - For each day older than retentionDays, prune raw samples after computing.
 *  - Backfill missing days with NULL-activity rows. */
export function downsampleRange(
  store: UsageHistoryStore,
  fromUtc: string,
  toUtc: string,
  opts: DownsampleOptions & { retentionDays: number; force?: boolean },
): UsageDailyRow[] {
  const { gapThresholdMinutes, retentionDays, force = false } = opts;
  const results: UsageDailyRow[] = [];
  const now = Date.now();
  const retentionCutoffMs = now - retentionDays * MS_PER_DAY;

  let cursor = fromUtc;
  while (cursor <= toUtc) {
    const dayStartMs = utcMidnightMs(cursor);
    const existing = store.getDailyRow(cursor);
    if (force || existing === null) {
      const row = downsampleDay(store, cursor, gapThresholdMinutes);
      results.push(row);
      // Prune raw samples for this day if it's older than retention.
      if (dayStartMs < retentionCutoffMs) {
        const pruned = store.deleteSamplesInRange(cursor, cursor);
        if (pruned > 0) {
          log.info(`pruned ${pruned} raw samples for ${cursor} (older than retention)`);
        }
      }
    }
    cursor = addDays(cursor, 1);
  }
  return results;
}

/** Prune all usage_samples rows older than retentionDays. Returns pruned count. */
export function pruneOldSamples(store: UsageHistoryStore, retentionDays: number): number {
  const cutoffMs = Date.now() - retentionDays * MS_PER_DAY;
  return store.deleteSamplesOlderThan(cutoffMs);
}

/** Compute milliseconds until next UTC 00:00:00. */
export function msUntilNextUtcMidnight(): number {
  const now = new Date();
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return nextMidnight - now.getTime();
}
