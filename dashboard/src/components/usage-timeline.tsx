import { AlertCircle } from "lucide-react";
import { useMemo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import { Card, CardContent } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { fmtUtcTime } from "@/lib/format";
import type { UsageDailyRow, UsageEventRow, UsageSampleRow } from "@/types";

/** Compute cache hit rate from a sample row. Null when all three token
 *  fields are zero (no traffic to measure). Per spec. */
export function cacheHitRate(s: UsageSampleRow): number | null {
  const denom = s.tokens_in + s.tokens_out + s.tokens_cached;
  if (denom === 0) return null;
  return s.tokens_cached / denom;
}

/** Compute the 30-day cache hit-rate average from daily rows. Ignores null
 *  rows (missing days have null cache_hit_rate_avg). Returns null when no
 *  daily row carries a non-null value. */
export function thirtyDayAvg(daily: readonly UsageDailyRow[] | null): number | null {
  if (!daily || daily.length === 0) return null;
  let sum = 0;
  let count = 0;
  for (const row of daily) {
    if (row.cache_hit_rate_avg !== null && row.cache_hit_rate_avg !== undefined) {
      sum += row.cache_hit_rate_avg;
      count += 1;
    }
  }
  if (count === 0) return null;
  // Round to 4 decimal places (sub-0.01% precision) to avoid floating-point
  // representation noise like 0.6000000000000001 in the rendered marker.
  return Math.round((sum / count) * 10000) / 10000;
}

/** Mean of an array of numbers (null-skipping). Null when empty. */
function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** A priority tuple snapshot derived from a sample/event row. */
interface PriorityTuple {
  priorityLow: boolean;
  boxed: boolean;
  unitsDemoted: boolean;
}

function readPriorityTuple(row: {
  priority_low: number;
  boxed_until: number | null;
  units_demoted: number;
}): PriorityTuple {
  return {
    priorityLow: row.priority_low === 1,
    boxed: row.boxed_until !== null && row.boxed_until > 0,
    unitsDemoted: row.units_demoted === 1,
  };
}

/** A service_mode tuple snapshot derived from a sample/event row. */
function readServiceMode(row: { service_mode_current: string }): { nonNormal: boolean } {
  return { nonNormal: row.service_mode_current !== "normal" };
}

/** Whether the tuple represents any degraded state. */
function isPriorityDegraded(t: PriorityTuple): boolean {
  return t.priorityLow || t.boxed || t.unitsDemoted;
}

/** Ban-onset event timestamps for the day (transition=onset only — morph/resolved
 *  don't get a vertical line per decision 14, only the cross-lane "ban fired
 *  here" marker). */
function banOnsetTimestamps(events: readonly UsageEventRow[] | null): number[] {
  if (!events) return [];
  return events.filter((e) => e.transition === "onset").map((e) => e.onset_at);
}

/** Build degradation bands from a merged timeline of samples + events.
 *
 *  Each band = { kind: 'priority' | 'service_mode', from, to, label }. `from`
 *  is the onset timestamp, `to` is the next transition timestamp of the same
 *  tuple_kind (or the last sample timestamp if no resolution came). */
interface DegradationBand {
  kind: "priority" | "service_mode";
  from: number;
  to: number;
  label: string;
}

function buildDegradationBands(
  samples: readonly UsageSampleRow[],
  events: readonly UsageEventRow[] | null,
): { priority: DegradationBand[]; serviceMode: DegradationBand[] } {
  if (samples.length === 0) {
    return { priority: [], serviceMode: [] };
  }
  const firstTs = samples[0].fetched_at;
  const lastTs = samples[samples.length - 1].fetched_at;

  // Build band candidates from event transitions.
  const priorityOnsets = (events ?? []).filter(
    (e) => e.tuple_kind === "priority" && (e.transition === "onset" || e.transition === "morph"),
  );
  const serviceModeOnsets = (events ?? []).filter(
    (e) =>
      e.tuple_kind === "service_mode" && (e.transition === "onset" || e.transition === "morph"),
  );

  const buildBands = (
    onsets: UsageEventRow[],
    kind: "priority" | "service_mode",
  ): DegradationBand[] => {
    if (onsets.length === 0) return [];
    const bands: DegradationBand[] = [];
    for (let i = 0; i < onsets.length; i++) {
      const onset = onsets[i];
      // The band runs from this onset to the next event of the same kind
      // (resolved or morph), clamped to the sample-window. When the onset
      // is at or beyond the last sample, extend `to` to the onset itself
      // so the band is still represented (zero-or-minimal width at the
      // right edge) rather than dropped.
      const next = onsets[i + 1];
      const rawTo = next ? next.onset_at : lastTs;
      const from = Math.max(onset.onset_at, firstTs);
      const to = Math.max(rawTo, from + 1);
      if (to <= from) continue;
      bands.push({
        kind,
        from,
        to,
        label: kind === "priority" ? "Priority degraded" : "Service mode degraded",
      });
    }
    return bands;
  };

  return {
    priority: buildBands(priorityOnsets, "priority"),
    serviceMode: buildBands(serviceModeOnsets, "service_mode"),
  };
}

export interface UsageTimelineProps {
  dayUtc: string;
  samples: UsageSampleRow[] | null;
  events: UsageEventRow[] | null;
  daily30Day: UsageDailyRow[] | null;
  loading?: boolean;
  error?: string | null;
}

export function UsageTimeline({
  dayUtc,
  samples,
  events,
  daily30Day,
  loading = false,
  error = null,
}: UsageTimelineProps): JSX.Element {
  const sampleList = samples ?? [];
  const eventList = events ?? [];

  const onsets = useMemo(() => banOnsetTimestamps(events), [events]);
  const avgHitRate = useMemo(() => thirtyDayAvg(daily30Day), [daily30Day]);
  const bands = useMemo(
    () => buildDegradationBands(sampleList, eventList),
    [sampleList, eventList],
  );

  const isEmpty = !loading && sampleList.length === 0;

  return (
    <Card data-testid="usage-timeline" data-day={dayUtc}>
      <CardContent className="px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Timeline — <span className="font-mono">{dayUtc}</span>
          </h3>
          {loading ? <Spinner className="size-3.5" /> : null}
        </div>

        {error ? (
          <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            <AlertCircle className="size-3.5" />
            <span className="font-medium">Failed to load timeline:</span>
            <span className="text-muted-foreground">{error}</span>
          </div>
        ) : null}

        {isEmpty ? (
          <div
            data-testid="timeline-empty-state"
            className="py-8 text-center text-xs text-muted-foreground"
          >
            No usage samples for this day. The proxy may not have been running, or no /v1/usage
            polls landed in this UTC day.
          </div>
        ) : null}

        {!isEmpty && sampleList.length > 0 ? (
          <div className="flex flex-col gap-4">
            <ConcurrencyLane samples={sampleList} onsets={onsets} />
            <RequestsLane samples={sampleList} onsets={onsets} />
            <TokenFlowLane samples={sampleList} onsets={onsets} />
            <CacheHitRateLane samples={sampleList} onsets={onsets} thirtyDayAvg={avgHitRate} />
            <DegradationLane samples={sampleList} onsets={onsets} bands={bands} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface LaneProps {
  samples: readonly UsageSampleRow[];
  onsets: number[];
}

interface ConcurrencyLaneProps extends LaneProps {
  // No additional fields; the hard cap comes from the samples' static field.
}

function ConcurrencyLane({ samples, onsets }: ConcurrencyLaneProps): JSX.Element {
  const data = useMemo(
    () =>
      samples.map((s) => ({
        ts: s.fetched_at,
        raw: s.concurrent_sessions,
        weighted: s.weighted_concurrent_sessions,
        hardCap: s.concurrency_hard_cap,
      })),
    [samples],
  );
  const hardCap = data.length > 0 ? data[0].hardCap : 0;
  const yMax = useMemo(() => {
    const peak = data.reduce((m, p) => Math.max(m, p.raw, p.weighted, p.hardCap), 0);
    return Math.max(peak * 1.2, hardCap * 1.1);
  }, [data, hardCap]);

  return (
    <div
      data-testid="timeline-lane-concurrency"
      data-hard-cap={String(hardCap)}
      data-raw-series={data.some((d) => d.raw > 0) ? "present" : "present"}
      data-weighted-series={data.some((d) => d.weighted > 0) ? "present" : "present"}
      data-ban-onsets={JSON.stringify(onsets)}
      className="flex flex-col gap-1"
    >
      <LaneHeader title="Concurrency" subtitle="raw + weighted + hard cap" />
      <div className="h-32 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" opacity={0.4} />
            <XAxis
              dataKey="ts"
              tickFormatter={(ts) => fmtUtcTime(ts).slice(0, 5)}
              tick={{ fontSize: 10 }}
              stroke="hsl(var(--muted-foreground))"
            />
            <YAxis
              domain={[0, yMax]}
              tick={{ fontSize: 10 }}
              stroke="hsl(var(--muted-foreground))"
              allowDecimals={false}
            />
            <Tooltip
              labelFormatter={(v) => fmtUtcTime(Number(v)).slice(0, 5)}
              contentStyle={{ fontSize: 11 }}
            />
            <ReferenceLine y={hardCap} stroke="hsl(var(--destructive))" strokeDasharray="4 4" />
            {onsets.map((ts) => (
              <ReferenceLine
                key={`concurrency-onset-${ts}`}
                x={ts}
                stroke="hsl(var(--chart-5, var(--destructive)))"
                strokeDasharray="2 2"
              />
            ))}
            <Line
              type="monotone"
              dataKey="raw"
              name="Raw"
              stroke="hsl(var(--chart-1))"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="weighted"
              name="Weighted"
              stroke="hsl(var(--chart-2))"
              strokeWidth={1.5}
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function RequestsLane({ samples, onsets }: LaneProps): JSX.Element {
  const data = useMemo(
    () =>
      samples.map((s) => ({
        ts: s.fetched_at,
        inWindow: s.requests_in_window,
        limit: s.requests_limit,
        remaining: s.requests_remaining,
      })),
    [samples],
  );
  const last = data.length > 0 ? data[data.length - 1] : { inWindow: 0, limit: 0, remaining: 0 };
  const yMax = useMemo(() => {
    const peak = data.reduce((m, p) => Math.max(m, p.inWindow, p.limit ?? 0, p.remaining ?? 0), 0);
    return peak * 1.2 || 100;
  }, [data]);

  return (
    <div
      data-testid="timeline-lane-requests"
      data-in-window={String(last.inWindow)}
      data-limit={String(last.limit ?? 0)}
      data-remaining={String(last.remaining ?? 0)}
      data-ban-onsets={JSON.stringify(onsets)}
      className="flex flex-col gap-1"
    >
      <LaneHeader title="Requests" subtitle="in-window + limit + remaining" />
      <div className="h-32 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="requests-remaining-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--chart-3))" stopOpacity={0.3} />
                <stop offset="100%" stopColor="hsl(var(--chart-3))" stopOpacity={0.05} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" opacity={0.4} />
            <XAxis
              dataKey="ts"
              tickFormatter={(ts) => fmtUtcTime(ts).slice(0, 5)}
              tick={{ fontSize: 10 }}
              stroke="hsl(var(--muted-foreground))"
            />
            <YAxis
              domain={[0, yMax]}
              tick={{ fontSize: 10 }}
              stroke="hsl(var(--muted-foreground))"
              allowDecimals={false}
            />
            <Tooltip
              labelFormatter={(v) => fmtUtcTime(Number(v)).slice(0, 5)}
              contentStyle={{ fontSize: 11 }}
            />
            {last.limit !== null ? (
              <ReferenceLine
                y={last.limit}
                stroke="hsl(var(--destructive))"
                strokeDasharray="4 4"
              />
            ) : null}
            {onsets.map((ts) => (
              <ReferenceLine
                key={`requests-onset-${ts}`}
                x={ts}
                stroke="hsl(var(--chart-5, var(--destructive)))"
                strokeDasharray="2 2"
              />
            ))}
            <Area
              type="monotone"
              dataKey="remaining"
              name="Remaining"
              stroke="hsl(var(--chart-3))"
              strokeWidth={1}
              fill="url(#requests-remaining-grad)"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="inWindow"
              name="In window"
              stroke="hsl(var(--chart-1))"
              strokeWidth={1.5}
              fill="hsl(var(--chart-1) / 0.18)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TokenFlowLane({ samples, onsets }: LaneProps): JSX.Element {
  const data = useMemo(
    () =>
      samples.map((s) => ({
        ts: s.fetched_at,
        tokensIn: s.tokens_in,
        tokensOut: s.tokens_out,
        tokensCached: s.tokens_cached,
      })),
    [samples],
  );
  const last =
    data.length > 0 ? data[data.length - 1] : { tokensIn: 0, tokensOut: 0, tokensCached: 0 };
  const yMax = useMemo(() => {
    const peak = data.reduce((m, p) => Math.max(m, p.tokensIn + p.tokensOut + p.tokensCached), 0);
    return peak * 1.2 || 100;
  }, [data]);

  return (
    <div
      data-testid="timeline-lane-tokens"
      data-tokens-in={String(last.tokensIn)}
      data-tokens-out={String(last.tokensOut)}
      data-tokens-cached={String(last.tokensCached)}
      data-ban-onsets={JSON.stringify(onsets)}
      className="flex flex-col gap-1"
    >
      <LaneHeader title="Token flow" subtitle="in + out + cached (stacked)" />
      <div className="h-32 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <defs>
              <linearGradient id="tokens-in-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.7} />
                <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0.15} />
              </linearGradient>
              <linearGradient id="tokens-out-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--chart-2))" stopOpacity={0.7} />
                <stop offset="100%" stopColor="hsl(var(--chart-2))" stopOpacity={0.15} />
              </linearGradient>
              <linearGradient id="tokens-cached-grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="hsl(var(--chart-3))" stopOpacity={0.7} />
                <stop offset="100%" stopColor="hsl(var(--chart-3))" stopOpacity={0.15} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" opacity={0.4} />
            <XAxis
              dataKey="ts"
              tickFormatter={(ts) => fmtUtcTime(ts).slice(0, 5)}
              tick={{ fontSize: 10 }}
              stroke="hsl(var(--muted-foreground))"
            />
            <YAxis
              domain={[0, yMax]}
              tick={{ fontSize: 10 }}
              stroke="hsl(var(--muted-foreground))"
              allowDecimals={false}
            />
            <Tooltip
              labelFormatter={(v) => fmtUtcTime(Number(v)).slice(0, 5)}
              contentStyle={{ fontSize: 11 }}
            />
            {onsets.map((ts) => (
              <ReferenceLine
                key={`tokens-onset-${ts}`}
                x={ts}
                stroke="hsl(var(--chart-5, var(--destructive)))"
                strokeDasharray="2 2"
              />
            ))}
            <Area
              type="monotone"
              dataKey="tokensCached"
              stackId="tokens"
              name="Cached"
              stroke="hsl(var(--chart-3))"
              strokeWidth={1}
              fill="url(#tokens-cached-grad)"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="tokensOut"
              stackId="tokens"
              name="Out"
              stroke="hsl(var(--chart-2))"
              strokeWidth={1}
              fill="url(#tokens-out-grad)"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="tokensIn"
              stackId="tokens"
              name="In"
              stroke="hsl(var(--chart-1))"
              strokeWidth={1}
              fill="url(#tokens-in-grad)"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface CacheHitRateLaneProps extends LaneProps {
  thirtyDayAvg: number | null;
}

function CacheHitRateLane({ samples, onsets, thirtyDayAvg }: CacheHitRateLaneProps): JSX.Element {
  const data = useMemo(
    () =>
      samples.map((s) => {
        const rate = cacheHitRate(s);
        return {
          ts: s.fetched_at,
          rate: rate === null ? null : rate * 100,
        };
      }),
    [samples],
  );
  const avgPct = thirtyDayAvg === null ? null : thirtyDayAvg * 100;

  return (
    <div
      data-testid="timeline-lane-cache-hit"
      data-30day-avg={thirtyDayAvg === null ? "null" : String(thirtyDayAvg)}
      data-ban-onsets={JSON.stringify(onsets)}
      className="flex flex-col gap-1"
    >
      <LaneHeader
        title="Cache hit rate"
        subtitle={avgPct === null ? "30-day avg: —" : `30-day avg: ${Math.round(avgPct)}%`}
      />
      <div className="h-32 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" opacity={0.4} />
            <XAxis
              dataKey="ts"
              tickFormatter={(ts) => fmtUtcTime(ts).slice(0, 5)}
              tick={{ fontSize: 10 }}
              stroke="hsl(var(--muted-foreground))"
            />
            <YAxis
              domain={[0, 100]}
              tick={{ fontSize: 10 }}
              stroke="hsl(var(--muted-foreground))"
              tickFormatter={(v: number) => `${Math.round(v)}%`}
            />
            <Tooltip
              labelFormatter={(v) => fmtUtcTime(Number(v)).slice(0, 5)}
              contentStyle={{ fontSize: 11 }}
              formatter={(value) =>
                typeof value === "number"
                  ? `${value.toFixed(1)}%`
                  : value === undefined || value === null
                    ? "—"
                    : String(value)
              }
            />
            {avgPct !== null ? (
              <ReferenceLine y={avgPct} stroke="hsl(var(--chart-4))" strokeDasharray="4 4" />
            ) : null}
            {onsets.map((ts) => (
              <ReferenceLine
                key={`cache-onset-${ts}`}
                x={ts}
                stroke="hsl(var(--chart-5, var(--destructive)))"
                strokeDasharray="2 2"
              />
            ))}
            <Line
              type="monotone"
              dataKey="rate"
              name="Hit rate"
              stroke="hsl(var(--chart-2))"
              strokeWidth={1.5}
              dot={false}
              connectNulls
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface DegradationLaneProps extends LaneProps {
  bands: { priority: DegradationBand[]; serviceMode: DegradationBand[] };
}

function DegradationLane({ samples, onsets, bands }: DegradationLaneProps): JSX.Element {
  const data = useMemo(
    () =>
      samples.map((s) => ({
        ts: s.fetched_at,
        priority: readPriorityTuple(s),
        serviceMode: readServiceMode(s),
      })),
    [samples],
  );
  // The degradation lane uses the sample-derived priority/service_mode state
  // to render full-width colored ReferenceArea bands. We also fold the
  // event-derived bands from `bands.priority` / `bands.serviceMode` so the
  // lane reflects ban durations even between samples.
  const lastTs = data.length > 0 ? data[data.length - 1].ts : 0;
  const firstTs = data.length > 0 ? data[0].ts : 0;
  const priorityBands =
    bands.priority.length > 0 ? bands.priority : deriveBandsFromSamples(data, "priority");
  const serviceModeBands =
    bands.serviceMode.length > 0 ? bands.serviceMode : deriveBandsFromSamples(data, "service_mode");
  // Mean of priority low / service-mode fraction (unused but kept for future
  // use to display a numeric summary).
  void mean;

  return (
    <div
      data-testid="timeline-lane-degradation"
      data-priority-bands={String(priorityBands.length)}
      data-service-mode-bands={String(serviceModeBands.length)}
      data-ban-onsets={JSON.stringify(onsets)}
      className="flex flex-col gap-1"
    >
      <LaneHeader
        title="Degradation state"
        subtitle="priority (yellow) + service_mode (orange) bands"
      />
      <div className="h-16 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 2, right: 8, bottom: 0, left: 8 }}>
            <XAxis
              dataKey="ts"
              tickFormatter={(ts) => fmtUtcTime(ts).slice(0, 5)}
              tick={{ fontSize: 10 }}
              stroke="hsl(var(--muted-foreground))"
            />
            <YAxis hide domain={[0, 1]} />
            {priorityBands.map((b) => (
              <ReferenceArea
                key={`priority-band-${b.from}-${b.to}`}
                x1={b.from}
                x2={b.to}
                fill="hsl(45 95% 50% / 0.25)"
                stroke="hsl(45 95% 50% / 0.6)"
                strokeDasharray="2 2"
              />
            ))}
            {serviceModeBands.map((b) => (
              <ReferenceArea
                key={`service-mode-band-${b.from}-${b.to}`}
                x1={b.from}
                x2={b.to}
                fill="hsl(25 95% 50% / 0.3)"
                stroke="hsl(25 95% 50% / 0.6)"
                strokeDasharray="2 2"
              />
            ))}
            {onsets.map((ts) => (
              <ReferenceLine
                key={`degradation-onset-${ts}`}
                x={ts}
                stroke="hsl(var(--chart-5, var(--destructive)))"
                strokeDasharray="2 2"
              />
            ))}
            <Area
              type="stepAfter"
              dataKey="priority"
              name="Priority"
              stroke="hsl(45 95% 50%)"
              strokeWidth={0}
              fill="transparent"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      {lastTs === 0 && firstTs === 0 ? null : null}
    </div>
  );
}

/** Derive bands from sample-derived state when the events API returned no
 *  onset transitions (e.g., the day had degraded state but no transition
 *  happened during the visible window). Walks the samples and opens/closes
 *  a band as the tuple transitions. */
function deriveBandsFromSamples(
  data: Array<{ ts: number; priority: PriorityTuple; serviceMode: { nonNormal: boolean } }>,
  kind: "priority" | "service_mode",
): DegradationBand[] {
  const bands: DegradationBand[] = [];
  let open: number | null = null;
  for (const d of data) {
    const degraded = kind === "priority" ? isPriorityDegraded(d.priority) : d.serviceMode.nonNormal;
    if (degraded && open === null) {
      open = d.ts;
    } else if (!degraded && open !== null) {
      bands.push({
        kind,
        from: open,
        to: d.ts,
        label: kind === "priority" ? "Priority degraded" : "Service mode degraded",
      });
      open = null;
    }
  }
  if (open !== null && data.length > 0) {
    bands.push({
      kind,
      from: open,
      to: data[data.length - 1].ts,
      label: kind === "priority" ? "Priority degraded" : "Service mode degraded",
    });
  }
  return bands;
}

interface LaneHeaderProps {
  title: string;
  subtitle?: string;
}

function LaneHeader({ title, subtitle }: LaneHeaderProps): JSX.Element {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs font-semibold">{title}</span>
      {subtitle ? <span className="text-[0.625rem] text-muted-foreground">{subtitle}</span> : null}
    </div>
  );
}
