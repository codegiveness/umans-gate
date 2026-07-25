import { AlertCircle } from "lucide-react";
import { useMemo } from "react";
import {
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
import { thirtyDayAvg } from "@/components/usage-timeline";
import { fmtInt, fmtUtcTime } from "@/lib/format";
import {
  buildEventMarkers,
  buildRealBands,
  buildStepPoints,
  dayEndMs,
  dayStartMs,
  type EventMarker,
  type RealBand,
} from "@/lib/usage-timeline-old";
import type { UsageDailyRow, UsageEventRow } from "@/types";

export interface UsageTimelineOldProps {
  dayUtc: string;
  daily: UsageDailyRow | null;
  events: UsageEventRow[] | null;
  daily30Day: UsageDailyRow[] | null;
  loading?: boolean;
  error?: string | null;
}

/** Old-day timeline (ticket 06). Renders the same 5 lanes as ticket 05 but
 *  from `usage_daily` + `usage_events` instead of raw samples, with a hybrid
 *  step-function visualization: dashed held-constant segments between events,
 *  event markers at exact timestamps with ambient context, and accurate
 *  degradation bands (real onset → real resolution). */
export function UsageTimelineOld({
  dayUtc,
  daily,
  events,
  daily30Day,
  loading = false,
  error = null,
}: UsageTimelineOldProps): React.JSX.Element {
  const eventList = events ?? [];
  const sortedEvents = useMemo(
    () => [...eventList].sort((a, b) => a.onset_at - b.onset_at),
    [eventList],
  );

  const startMs = dayStartMs(dayUtc);
  const endMs = dayEndMs(dayUtc);

  const avgHitRate = useMemo(() => thirtyDayAvg(daily30Day), [daily30Day]);
  const markers = useMemo(() => buildEventMarkers(sortedEvents), [sortedEvents]);
  const bands = useMemo(
    () => buildRealBands(sortedEvents, startMs, endMs),
    [sortedEvents, startMs, endMs],
  );

  const isEmpty = !loading && !daily && sortedEvents.length === 0;
  // Zero-events-with-daily case: render flat dashed lines at daily aggregates.
  const isFlat = !isEmpty && sortedEvents.length === 0 && daily !== null;
  // Step-function case: events exist, lanes jump at each event.
  const isStep = sortedEvents.length > 0;

  return (
    <Card
      data-testid="usage-timeline-old"
      data-day={dayUtc}
      data-day-completeness={daily?.day_completeness ?? "missing"}
    >
      <CardContent className="px-4 py-3">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            Timeline — <span className="font-mono">{dayUtc}</span>
            <span className="ml-2 text-[0.625rem] font-normal text-muted-foreground">
              (historical: from daily + events)
            </span>
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
            data-testid="timeline-old-empty-state"
            className="py-8 text-center text-xs text-muted-foreground"
          >
            No daily aggregate or events for this day. The proxy may not have been running, or no
            /v1/usage polls landed in this UTC day.
          </div>
        ) : null}

        {!isEmpty ? (
          <div className="flex flex-col gap-4">
            <ConcurrencyLaneOld
              daily={daily}
              events={sortedEvents}
              markers={markers}
              startMs={startMs}
              endMs={endMs}
              isFlat={isFlat}
              isStep={isStep}
            />
            <RequestsLaneOld
              daily={daily}
              events={sortedEvents}
              startMs={startMs}
              endMs={endMs}
              isFlat={isFlat}
              isStep={isStep}
            />
            <TokenFlowLaneOld
              daily={daily}
              events={sortedEvents}
              startMs={startMs}
              endMs={endMs}
              isFlat={isFlat}
              isStep={isStep}
            />
            <CacheHitRateLaneOld
              daily={daily}
              events={sortedEvents}
              thirtyDayAvg={avgHitRate}
              startMs={startMs}
              endMs={endMs}
              isFlat={isFlat}
              isStep={isStep}
            />
            <DegradationLaneOld bands={bands} markers={markers} startMs={startMs} endMs={endMs} />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

interface OldLaneSharedProps {
  daily: UsageDailyRow | null;
  events: readonly UsageEventRow[];
  startMs: number;
  endMs: number;
  isFlat: boolean;
  isStep: boolean;
}

function ConcurrencyLaneOld(
  props: OldLaneSharedProps & { markers: EventMarker[] },
): React.JSX.Element {
  const { daily, events, markers, startMs, endMs, isFlat, isStep } = props;
  const hardCap = daily?.concurrency_hard_cap ?? 0;

  const data = useMemo(() => {
    if (isFlat) {
      const peak = daily?.concurrent_sessions_peak ?? 0;
      return [
        { ts: startMs, raw: peak, weighted: peak, hardCap },
        { ts: endMs, raw: peak, weighted: peak, hardCap },
      ];
    }
    // isStep
    const baseline = daily?.concurrent_sessions_peak ?? 0;
    const rawPoints = buildStepPoints(
      startMs,
      endMs,
      events,
      baseline,
      (e) => e.concurrent_sessions,
    );
    const weightedBaseline = daily?.weighted_concurrent_sessions_peak ?? 0;
    const weightedPoints = buildStepPoints(
      startMs,
      endMs,
      events,
      weightedBaseline,
      (e) => e.weighted_concurrent_sessions,
    );
    // Merge into a single dataset keyed by ts; ReferenceLine per event.
    const tsSet = new Set<number>();
    for (const p of rawPoints) tsSet.add(p.ts);
    for (const p of weightedPoints) tsSet.add(p.ts);
    const tss = [...tsSet].sort((a, b) => a - b);
    const rawByTs = new Map(rawPoints.map((p) => [p.ts, p.value]));
    const weightedByTs = new Map(weightedPoints.map((p) => [p.ts, p.value]));
    // Step-function: each ts holds the most recent known value at or before it.
    let lastRaw = rawPoints[0]?.value ?? 0;
    let lastWeighted = weightedPoints[0]?.value ?? 0;
    return tss.map((ts) => {
      if (rawByTs.has(ts)) lastRaw = rawByTs.get(ts) as number;
      if (weightedByTs.has(ts)) lastWeighted = weightedByTs.get(ts) as number;
      return { ts, raw: lastRaw, weighted: lastWeighted, hardCap };
    });
  }, [isFlat, daily, events, startMs, endMs, hardCap]);

  const yMax = useMemo(() => {
    const peak = data.reduce((m, p) => Math.max(m, p.raw, p.weighted, p.hardCap), hardCap);
    return Math.max(peak * 1.2, hardCap * 1.1);
  }, [data, hardCap]);

  const stepPoints = isStep ? data.map((d) => d.ts) : [];
  const renderMode = isFlat ? "dashed-flat" : isStep ? "dashed-step" : "none";

  return (
    <div
      data-testid="timeline-lane-concurrency"
      data-render-mode={renderMode}
      data-hard-cap={String(hardCap)}
      data-flat-peak={String(daily?.concurrent_sessions_peak ?? 0)}
      data-step-points={JSON.stringify(stepPoints)}
      data-event-markers={JSON.stringify(
        markers.map((m) => ({
          onset_at: m.onset_at,
          concurrent_sessions: m.concurrent_sessions,
        })),
      )}
      className="flex flex-col gap-1"
    >
      <LaneHeader title="Concurrency" subtitle="raw + weighted + hard cap (held-constant)" />
      <div className="h-32 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" opacity={0.4} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={[startMs, endMs]}
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
              formatter={(value) => (typeof value === "number" ? fmtInt(value) : (value ?? "—"))}
            />
            <ReferenceLine y={hardCap} stroke="hsl(var(--destructive))" strokeDasharray="4 4" />
            {markers.map((m) => (
              <ReferenceLine
                key={`concurrency-marker-${m.onset_at}`}
                x={m.onset_at}
                stroke="hsl(var(--chart-5, var(--destructive)))"
                strokeDasharray="2 2"
              />
            ))}
            <Line
              type="stepAfter"
              dataKey="raw"
              name="Raw"
              stroke="hsl(var(--chart-1))"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="stepAfter"
              dataKey="weighted"
              name="Weighted"
              stroke="hsl(var(--chart-2))"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function RequestsLaneOld(props: OldLaneSharedProps): React.JSX.Element {
  const { daily, events, startMs, endMs, isFlat, isStep } = props;
  const limit = daily?.requests_limit ?? 0;

  const data = useMemo(() => {
    if (isFlat) {
      const peak = daily?.requests_in_window_peak ?? 0;
      return [
        { ts: startMs, inWindow: peak, remaining: peak, limit },
        { ts: endMs, inWindow: peak, remaining: peak, limit },
      ];
    }
    const baseline = daily?.requests_in_window_peak ?? 0;
    const inWindowPoints = buildStepPoints(
      startMs,
      endMs,
      events,
      baseline,
      (e) => e.requests_in_window,
    );
    const remainingBaseline = daily?.requests_in_window_peak ?? 0;
    const remainingPoints = buildStepPoints(
      startMs,
      endMs,
      events,
      remainingBaseline,
      (e) => e.requests_remaining ?? 0,
    );
    const tsSet = new Set<number>();
    for (const p of inWindowPoints) tsSet.add(p.ts);
    for (const p of remainingPoints) tsSet.add(p.ts);
    const tss = [...tsSet].sort((a, b) => a - b);
    const inWindowByTs = new Map(inWindowPoints.map((p) => [p.ts, p.value]));
    const remainingByTs = new Map(remainingPoints.map((p) => [p.ts, p.value]));
    let lastInWindow = inWindowPoints[0]?.value ?? 0;
    let lastRemaining = remainingPoints[0]?.value ?? 0;
    return tss.map((ts) => {
      if (inWindowByTs.has(ts)) lastInWindow = inWindowByTs.get(ts) as number;
      if (remainingByTs.has(ts)) lastRemaining = remainingByTs.get(ts) as number;
      return { ts, inWindow: lastInWindow, remaining: lastRemaining, limit };
    });
  }, [isFlat, daily, events, startMs, endMs, limit]);

  const yMax = useMemo(() => {
    const peak = data.reduce((m, p) => Math.max(m, p.inWindow, p.limit, p.remaining), limit);
    return peak * 1.2 || 100;
  }, [data, limit]);

  return (
    <div
      data-testid="timeline-lane-requests"
      data-render-mode={isFlat ? "dashed-flat" : isStep ? "dashed-step" : "none"}
      data-flat-peak={String(daily?.requests_in_window_peak ?? 0)}
      data-step-points={JSON.stringify(isStep ? data.map((d) => d.ts) : [])}
      className="flex flex-col gap-1"
    >
      <LaneHeader title="Requests" subtitle="in-window + limit + remaining (held-constant)" />
      <div className="h-32 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" opacity={0.4} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={[startMs, endMs]}
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
              formatter={(value) => (typeof value === "number" ? fmtInt(value) : (value ?? "—"))}
            />
            {limit > 0 ? (
              <ReferenceLine y={limit} stroke="hsl(var(--destructive))" strokeDasharray="4 4" />
            ) : null}
            {events.map((e) => (
              <ReferenceLine
                key={`requests-marker-${e.id}`}
                x={e.onset_at}
                stroke="hsl(var(--chart-5, var(--destructive)))"
                strokeDasharray="2 2"
              />
            ))}
            <Line
              type="stepAfter"
              dataKey="inWindow"
              name="In window"
              stroke="hsl(var(--chart-1))"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="stepAfter"
              dataKey="remaining"
              name="Remaining"
              stroke="hsl(var(--chart-3))"
              strokeWidth={1}
              strokeDasharray="2 4"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TokenFlowLaneOld(props: OldLaneSharedProps): React.JSX.Element {
  const { daily, events, startMs, endMs, isFlat, isStep } = props;

  const data = useMemo(() => {
    if (isFlat) {
      const inT = daily?.tokens_in_total ?? 0;
      const outT = daily?.tokens_out_total ?? 0;
      const cachedT = daily?.tokens_cached_total ?? 0;
      return [
        { ts: startMs, tokensIn: inT, tokensOut: outT, tokensCached: cachedT },
        { ts: endMs, tokensIn: inT, tokensOut: outT, tokensCached: cachedT },
      ];
    }
    const inBaseline = daily?.tokens_in_total ?? 0;
    const outBaseline = daily?.tokens_out_total ?? 0;
    const cachedBaseline = daily?.tokens_cached_total ?? 0;
    const inPoints = buildStepPoints(startMs, endMs, events, inBaseline, (e) => e.tokens_in);
    const outPoints = buildStepPoints(startMs, endMs, events, outBaseline, (e) => e.tokens_out);
    const cachedPoints = buildStepPoints(
      startMs,
      endMs,
      events,
      cachedBaseline,
      (e) => e.tokens_cached,
    );
    const tsSet = new Set<number>();
    for (const p of inPoints) tsSet.add(p.ts);
    for (const p of outPoints) tsSet.add(p.ts);
    for (const p of cachedPoints) tsSet.add(p.ts);
    const tss = [...tsSet].sort((a, b) => a - b);
    const inByTs = new Map(inPoints.map((p) => [p.ts, p.value]));
    const outByTs = new Map(outPoints.map((p) => [p.ts, p.value]));
    const cachedByTs = new Map(cachedPoints.map((p) => [p.ts, p.value]));
    let lastIn = inPoints[0]?.value ?? 0;
    let lastOut = outPoints[0]?.value ?? 0;
    let lastCached = cachedPoints[0]?.value ?? 0;
    return tss.map((ts) => {
      if (inByTs.has(ts)) lastIn = inByTs.get(ts) as number;
      if (outByTs.has(ts)) lastOut = outByTs.get(ts) as number;
      if (cachedByTs.has(ts)) lastCached = cachedByTs.get(ts) as number;
      return { ts, tokensIn: lastIn, tokensOut: lastOut, tokensCached: lastCached };
    });
  }, [isFlat, daily, events, startMs, endMs]);

  const yMax = useMemo(() => {
    const peak = data.reduce((m, p) => Math.max(m, p.tokensIn + p.tokensOut + p.tokensCached), 0);
    return peak * 1.2 || 100;
  }, [data]);

  return (
    <div
      data-testid="timeline-lane-tokens"
      data-render-mode={isFlat ? "dashed-flat" : isStep ? "dashed-step" : "none"}
      data-step-points={JSON.stringify(isStep ? data.map((d) => d.ts) : [])}
      className="flex flex-col gap-1"
    >
      <LaneHeader title="Token flow" subtitle="in + out + cached (held-constant, daily totals)" />
      <div className="h-32 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="2 2" opacity={0.4} />
            <XAxis
              dataKey="ts"
              type="number"
              domain={[startMs, endMs]}
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
              formatter={(value) => (typeof value === "number" ? fmtInt(value) : (value ?? "—"))}
            />
            {events.map((e) => (
              <ReferenceLine
                key={`tokens-marker-${e.id}`}
                x={e.onset_at}
                stroke="hsl(var(--chart-5, var(--destructive)))"
                strokeDasharray="2 2"
              />
            ))}
            <Line
              type="stepAfter"
              dataKey="tokensIn"
              name="In"
              stroke="hsl(var(--chart-1))"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="stepAfter"
              dataKey="tokensOut"
              name="Out"
              stroke="hsl(var(--chart-2))"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={false}
            />
            <Line
              type="stepAfter"
              dataKey="tokensCached"
              name="Cached"
              stroke="hsl(var(--chart-3))"
              strokeWidth={1.5}
              strokeDasharray="5 3"
              dot={false}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function CacheHitRateLaneOld(
  props: OldLaneSharedProps & { thirtyDayAvg: number | null },
): React.JSX.Element {
  const { daily, events, thirtyDayAvg, startMs, endMs, isFlat, isStep } = props;
  const avgPct = thirtyDayAvg === null ? null : thirtyDayAvg * 100;

  const data = useMemo(() => {
    if (isFlat) {
      const rate = daily?.cache_hit_rate_avg ?? 0;
      const pct = rate * 100;
      return [
        { ts: startMs, rate: pct },
        { ts: endMs, rate: pct },
      ];
    }
    const baseline = daily?.cache_hit_rate_avg ?? 0;
    const points = buildStepPoints(startMs, endMs, events, baseline, (e) => e.cache_hit_rate ?? 0);
    const tsSet = new Set(points.map((p) => p.ts));
    const tss = [...tsSet].sort((a, b) => a - b);
    const byTs = new Map(points.map((p) => [p.ts, p.value]));
    let last = points[0]?.value ?? 0;
    return tss.map((ts) => {
      if (byTs.has(ts)) last = byTs.get(ts) as number;
      return { ts, rate: last * 100 };
    });
  }, [isFlat, daily, events, startMs, endMs]);

  return (
    <div
      data-testid="timeline-lane-cache-hit"
      data-render-mode={isFlat ? "dashed-flat" : isStep ? "dashed-step" : "none"}
      data-30day-avg={thirtyDayAvg === null ? "null" : String(thirtyDayAvg)}
      data-step-points={JSON.stringify(isStep ? data.map((d) => d.ts) : [])}
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
              type="number"
              domain={[startMs, endMs]}
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
            {events.map((e) => (
              <ReferenceLine
                key={`cache-marker-${e.id}`}
                x={e.onset_at}
                stroke="hsl(var(--chart-5, var(--destructive)))"
                strokeDasharray="2 2"
              />
            ))}
            <Line
              type="stepAfter"
              dataKey="rate"
              name="Hit rate"
              stroke="hsl(var(--chart-2))"
              strokeWidth={1.5}
              strokeDasharray="5 3"
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

function DegradationLaneOld(props: {
  bands: { priority: RealBand[]; serviceMode: RealBand[] };
  markers: EventMarker[];
  startMs: number;
  endMs: number;
}): React.JSX.Element {
  const { bands, markers, startMs, endMs } = props;
  const onsetTimestamps = markers.filter((m) => m.transition === "onset").map((m) => m.onset_at);
  const data = [{ ts: startMs }, { ts: endMs }];

  return (
    <div
      data-testid="timeline-lane-degradation"
      data-priority-bands={String(bands.priority.length)}
      data-service-mode-bands={String(bands.serviceMode.length)}
      data-priority-bands-real={JSON.stringify(
        bands.priority.map((b) => ({ from: b.from, to: b.to })),
      )}
      data-service-mode-bands-real={JSON.stringify(
        bands.serviceMode.map((b) => ({ from: b.from, to: b.to })),
      )}
      data-ban-onsets={JSON.stringify(onsetTimestamps)}
      className="flex flex-col gap-1"
    >
      <LaneHeader
        title="Degradation state"
        subtitle="real onset → resolution bands (accurate, not extrapolated)"
      />
      <div className="h-16 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 2, right: 8, bottom: 0, left: 8 }}>
            <XAxis
              dataKey="ts"
              type="number"
              domain={[startMs, endMs]}
              tickFormatter={(ts) => fmtUtcTime(ts).slice(0, 5)}
              tick={{ fontSize: 10 }}
              stroke="hsl(var(--muted-foreground))"
            />
            <YAxis hide domain={[0, 1]} />
            {bands.priority.map((b) => (
              <ReferenceArea
                key={`priority-band-${b.from}-${b.to}`}
                x1={b.from}
                x2={b.to}
                fill="hsl(45 95% 50% / 0.25)"
                stroke="hsl(45 95% 50% / 0.6)"
                strokeDasharray="2 2"
              />
            ))}
            {bands.serviceMode.map((b) => (
              <ReferenceArea
                key={`service-mode-band-${b.from}-${b.to}`}
                x1={b.from}
                x2={b.to}
                fill="hsl(25 95% 50% / 0.3)"
                stroke="hsl(25 95% 50% / 0.6)"
                strokeDasharray="2 2"
              />
            ))}
            {onsetTimestamps.map((ts) => (
              <ReferenceLine
                key={`degradation-onset-${ts}`}
                x={ts}
                stroke="hsl(var(--chart-5, var(--destructive)))"
                strokeDasharray="2 2"
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

interface LaneHeaderProps {
  title: string;
  subtitle?: string;
}

function LaneHeader({ title, subtitle }: LaneHeaderProps): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between">
      <span className="text-xs font-semibold">{title}</span>
      {subtitle ? <span className="text-[0.625rem] text-muted-foreground">{subtitle}</span> : null}
    </div>
  );
}
