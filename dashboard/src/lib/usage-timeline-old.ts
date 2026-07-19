import type { UsageDailyRow, UsageEventRow } from "@/types";

/** A point on a held-constant step-function curve. `ts` is the timestamp
 *  where this value became known (event onset, or day start for the daily
 *  baseline). `value` is held constant from `ts` until the next point's `ts`.
 *  Carries the originating event id (or null for the daily-baseline point). */
export interface StepPoint {
  ts: number;
  value: number;
  eventId: number | null;
}

/** A marker plotted at an event's exact onset timestamp, carrying the full
 *  ambient context at that transition for the tooltip. */
export interface EventMarker {
  onset_at: number;
  tuple_kind: "priority" | "service_mode";
  transition: "onset" | "resolved" | "morph";
  concurrent_sessions: number;
  weighted_concurrent_sessions: number;
  requests_in_window: number;
  requests_remaining: number | null;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cache_hit_rate: number | null;
  priority_low: number;
  boxed_until: number | null;
  service_mode_current: string;
}

/** A degradation band spanning real onset → real resolution timestamps.
 *  Accurate — never extrapolated from daily aggregates. */
export interface RealBand {
  from: number;
  to: number;
  kind: "priority" | "service_mode";
}

/** Build step-function points for a single numeric lane from events + a
 *  daily baseline. The first point sits at day start (UTC midnight) holding
 *  the daily aggregate's representative value (peak for concurrency, avg for
 *  cache hit rate, etc. — the caller picks). Each subsequent point sits at
 *  an event's onset_at and holds that event's recorded ambient value.
 *
 *  Per decision 15: between events the lane is held constant (step-function),
 *  rendered dashed to signal "held-constant, not observed." */
export function buildStepPoints(
  dayStartMs: number,
  dayEndMs: number,
  events: readonly UsageEventRow[],
  dailyBaseline: number,
  readValue: (e: UsageEventRow) => number,
): StepPoint[] {
  const sorted = [...events].sort((a, b) => a.onset_at - b.onset_at);
  const points: StepPoint[] = [{ ts: dayStartMs, value: dailyBaseline, eventId: null }];
  for (const e of sorted) {
    // Clamp event timestamps to the day window so ReferenceLine / XAxis
    // don't render off-canvas.
    const ts = Math.max(dayStartMs, Math.min(dayEndMs, e.onset_at));
    points.push({ ts, value: readValue(e), eventId: e.id });
  }
  // Terminal point at day end holds the last known value so the step-function
  // extends to the right edge of the chart.
  if (points.length > 0) {
    const last = points[points.length - 1];
    if (last.ts < dayEndMs) {
      points.push({ ts: dayEndMs, value: last.value, eventId: last.eventId });
    }
  }
  return points;
}

/** Build event markers (one per event) carrying full ambient context. */
export function buildEventMarkers(events: readonly UsageEventRow[]): EventMarker[] {
  return [...events]
    .sort((a, b) => a.onset_at - b.onset_at)
    .map((e) => ({
      onset_at: e.onset_at,
      tuple_kind: e.tuple_kind,
      transition: e.transition,
      concurrent_sessions: e.concurrent_sessions,
      weighted_concurrent_sessions: e.weighted_concurrent_sessions,
      requests_in_window: e.requests_in_window,
      requests_remaining: e.requests_remaining,
      tokens_in: e.tokens_in,
      tokens_out: e.tokens_out,
      tokens_cached: e.tokens_cached,
      cache_hit_rate: e.cache_hit_rate,
      priority_low: e.priority_low,
      boxed_until: e.boxed_until,
      service_mode_current: e.service_mode_current,
    }));
}

/** Build accurate degradation bands from real onset → real resolution event
 *  timestamps. Walks the events chronologically per tuple_kind: an `onset`
 *  or `morph` event opens a band, the next `resolved` of the same kind closes
 *  it. If no resolution came, the band extends to the day's last event
 *  timestamp (or day end) — never extrapolated beyond observed event times.
 *
 *  Per ticket 06: "Degradation bands span from real onset to real resolution
 *  timestamps — accurate, not interpolated." */
export function buildRealBands(
  events: readonly UsageEventRow[],
  dayStartMs: number,
  dayEndMs: number,
): { priority: RealBand[]; serviceMode: RealBand[] } {
  const sorted = [...events].sort((a, b) => a.onset_at - b.onset_at);

  const buildKind = (kind: "priority" | "service_mode"): RealBand[] => {
    const bands: RealBand[] = [];
    let open: number | null = null;
    for (const e of sorted) {
      if (e.tuple_kind !== kind) continue;
      if (e.transition === "onset" || e.transition === "morph") {
        // Re-anchor the band start to this event (morph extends an open band;
        // onset while open re-opens from this timestamp).
        open = e.onset_at;
      } else if (e.transition === "resolved") {
        if (open !== null) {
          bands.push({ from: open, to: e.onset_at, kind });
          open = null;
        } else {
          // resolved with no prior onset: zero-width band at resolution ts.
          bands.push({ from: e.onset_at, to: e.onset_at, kind });
        }
      }
    }
    if (open !== null) {
      // No resolution event — extend to the last event timestamp of the same
      // kind, or day end if the open was the only event. Never extrapolated
      // past observed event times into the future beyond day end.
      const sameKind = sorted.filter((e) => e.tuple_kind === kind);
      const lastTs = sameKind.length > 0 ? sameKind[sameKind.length - 1].onset_at : dayEndMs;
      bands.push({ from: open, to: Math.max(lastTs, open), kind });
    }
    // Clamp bands to the day window.
    return bands
      .map((b) => ({
        from: Math.max(b.from, dayStartMs),
        to: Math.min(b.to, dayEndMs),
        kind: b.kind,
      }))
      .filter((b) => b.to >= b.from);
  };

  return { priority: buildKind("priority"), serviceMode: buildKind("service_mode") };
}

/** Find the daily row matching the selected day from a 30-day window fetch.
 *  Returns null if the day isn't in the window (e.g., day > 30 days old AND
 *  the daily endpoint wasn't queried for that exact day). Callers that need
 *  the daily row for an arbitrarily old day must fetch it explicitly. */
export function findDailyRow(
  daily30Day: readonly UsageDailyRow[] | null,
  dayUtc: string,
): UsageDailyRow | null {
  if (!daily30Day) return null;
  for (const r of daily30Day) {
    if (r.day_utc === dayUtc) return r;
  }
  return null;
}

/** UTC midnight ms epoch for a YYYY-MM-DD string. */
export function dayStartMs(dayUtc: string): number {
  return Date.UTC(
    Number.parseInt(dayUtc.slice(0, 4), 10),
    Number.parseInt(dayUtc.slice(5, 7), 10) - 1,
    Number.parseInt(dayUtc.slice(8, 10), 10),
  );
}

/** UTC midnight of the next day (exclusive end of this day). */
export function dayEndMs(dayUtc: string): number {
  return dayStartMs(dayUtc) + 24 * 60 * 60 * 1000;
}
