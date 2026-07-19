import type { UsageDailyRow } from "@/types";

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Format a Date as YYYY-MM-DD UTC. */
export function toDayUtc(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse a YYYY-MM-DD string to a UTC midnight Date. */
export function utcMidnight(dayUtc: string): Date {
  return new Date(`${dayUtc}T00:00:00.000Z`);
}

/** Add days to a YYYY-MM-DD string, returning YYYY-MM-DD. */
export function addDays(dayUtc: string, days: number): string {
  const ms = utcMidnight(dayUtc).getTime() + days * MS_PER_DAY;
  return toDayUtc(new Date(ms));
}

/** Inclusive day count between two YYYY-MM-DD strings. */
export function dayCount(from: string, to: string): number {
  return Math.round((utcMidnight(to).getTime() - utcMidnight(from).getTime()) / MS_PER_DAY) + 1;
}

/** Today's YYYY-MM-DD in UTC. */
export function todayUtc(): string {
  return toDayUtc(new Date());
}

export type RangePreset = "7d" | "30d" | "90d" | "1y" | "all";

export const RANGE_PRESETS: ReadonlyArray<{ value: RangePreset; label: string }> = [
  { value: "7d", label: "7d" },
  { value: "30d", label: "30d" },
  { value: "90d", label: "90d" },
  { value: "1y", label: "1y" },
  { value: "all", label: "all" },
];

/** Compute the {from, to} window for a preset, anchored at `todayUtc` (or the
 *  earliest available row for "all"). */
export function presetRange(
  preset: RangePreset,
  earliestDay: string | null,
): { from: string; to: string } {
  const today = todayUtc();
  switch (preset) {
    case "7d":
      return { from: addDays(today, -6), to: today };
    case "30d":
      return { from: addDays(today, -29), to: today };
    case "90d":
      return { from: addDays(today, -89), to: today };
    case "1y":
      return { from: addDays(today, -364), to: today };
    case "all":
      return earliestDay
        ? { from: earliestDay, to: today }
        : { from: addDays(today, -29), to: today };
  }
}

/** Index daily rows by day_utc for O(1) lookup. */
export function indexByDay(rows: readonly UsageDailyRow[]): Map<string, UsageDailyRow> {
  const m = new Map<string, UsageDailyRow>();
  for (const r of rows) m.set(r.day_utc, r);
  return m;
}

/** Enumerate every day in [from, to] inclusive, returning YYYY-MM-DD strings.
 *  Used to render backfill cells for missing days. */
export function enumerateDays(from: string, to: string): string[] {
  const out: string[] = [];
  const count = dayCount(from, to);
  for (let i = 0; i < count; i++) out.push(addDays(from, i));
  return out;
}

/** Activity-density bucket: 0 (none) → 3 (high). 4-step scale.
 /** Activity-density bucket: 0 (none) → 4 (high). 5-step scale.
 *  Thresholds (in active minutes): 0, 1-60, 61-180, 181-360, 361+.
 *  Null activity (missing day) → 0. */
export function activityLevel(row: UsageDailyRow | undefined): 0 | 1 | 2 | 3 | 4 {
  const m = row?.accumulated_active_minutes;
  if (m === null || m === undefined) return 0;
  if (m <= 0) return 0;
  if (m <= 60) return 1;
  if (m <= 180) return 2;
  if (m <= 360) return 3;
  return 4;
}

export type DegradationState = "none" | "priority" | "service_mode" | "both";

/** Degradation state for a day's border. "both" wins when priority and
 *  service_mode events co-occur (per decision 13: the more severe state wins). */
export function degradationState(row: UsageDailyRow | undefined): DegradationState {
  if (!row) return "none";
  const hasPriority = (row.priority_events_count ?? 0) > 0;
  const hasServiceMode = (row.service_mode_events_count ?? 0) > 0;
  if (hasPriority && hasServiceMode) return "both";
  if (hasServiceMode) return "service_mode";
  if (hasPriority) return "priority";
  return "none";
}

/** Border thickness 1-4 based on the degradation-duration fraction.
 *  Fraction = (priority_ban_total_duration_ms + service_mode_ban_total_duration_ms)
 *  / (utc_clock_span_minutes * 60 * 1000).
 *  Steps: 0 → 1 (thin), <15% → 1, 15-45% → 2, 45-75% → 3, >75% → 4. */
export function borderThickness(row: UsageDailyRow | undefined): 1 | 2 | 3 | 4 {
  if (!row) return 1;
  const spanMs = (row.utc_clock_span_minutes ?? 0) * 60 * 1000;
  if (spanMs <= 0) return 1;
  const degradedMs =
    (row.priority_ban_total_duration_ms ?? 0) + (row.service_mode_ban_total_duration_ms ?? 0);
  const frac = degradedMs / spanMs;
  if (frac <= 0) return 1;
  if (frac < 0.15) return 1;
  if (frac < 0.45) return 2;
  if (frac < 0.75) return 3;
  return 4;
}
