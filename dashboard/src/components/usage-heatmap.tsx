import { AlertCircle, Info, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, Brush, ResponsiveContainer, XAxis, YAxis } from "recharts";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChartFrame } from "@/components/ui/chart-frame";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  activityLevel,
  borderThickness,
  dayCount,
  degradationState,
  enumerateDays,
  indexByDay,
  RANGE_PRESETS,
  type RangePreset,
} from "@/lib/usage-heatmap";
import { cn } from "@/lib/utils";
import type { UsageDailyRow } from "@/types";

/** Background color classes per activity level (0=none, 4=high).
 *  Viridis-like ramp: pale → deep teal/blue.
 *  Five steps per decision 13 ("4–5 intensity steps"). */
const ACTIVITY_BG: Record<number, string> = {
  0: "bg-muted/40",
  1: "bg-sky-200/60 dark:bg-sky-900/40",
  2: "bg-sky-400/70 dark:bg-sky-700/60",
  3: "bg-teal-500/80 dark:bg-teal-600/80",
  4: "bg-teal-700 dark:bg-teal-400",
};

/** Border color classes per degradation state. */
const DEGRADATION_BORDER: Record<string, string> = {
  none: "border-transparent",
  priority: "border-yellow-500",
  service_mode: "border-orange-500",
  both: "border-red-600",
};

const DEGRADATION_LABEL: Record<string, string> = {
  none: "Normal",
  priority: "Priority-low",
  service_mode: "Service mode degraded",
  both: "Priority + service mode",
};

/** Border thickness in px (1-4) → Tailwind border-N class. */
function thicknessClass(px: number): string {
  // Tailwind: border, border-2, border-4, border-8. Map 1→border, 2→border-2,
  // 3→border-4, 4→border-8.
  switch (px) {
    case 2:
      return "border-2";
    case 3:
      return "border-4";
    case 4:
      return "border-8";
    default:
      return "border";
  }
}

function fmtMinutes(m: number | null | undefined): string {
  if (m === null || m === undefined) return "—";
  if (m < 60) return `${Math.round(m)}m`;
  const h = Math.floor(m / 60);
  const rem = Math.round(m % 60);
  return rem === 0 ? `${h}h` : `${h}h${rem}m`;
}

function fmtPct(x: number | null | undefined): string {
  if (x === null || x === undefined) return "—";
  return `${Math.round(x * 100)}%`;
}

export interface UsageHeatmapProps {
  rows: UsageDailyRow[] | null;
  from: string;
  to: string;
  preset: RangePreset;
  loading?: boolean;
  error?: string | null;
  refresh?: () => void;
  onSelectPreset: (preset: RangePreset) => void;
  onSelectDay: (dayUtc: string) => void;
  /** Fired when the user brushes a sub-range to zoom into. */
  onBrushRange: (from: string, to: string) => void;
}

export function UsageHeatmap({
  rows,
  from,
  to,
  preset,
  loading = false,
  error = null,
  refresh,
  onSelectPreset,
  onSelectDay,
  onBrushRange,
}: UsageHeatmapProps): React.JSX.Element {
  const days = useMemo(() => enumerateDays(from, to), [from, to]);
  const byDay = useMemo(() => indexByDay(rows ?? []), [rows]);

  const isEmpty = !loading && (rows?.length ?? 0) === 0;

  return (
    <div className="flex h-full flex-col gap-3">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          {RANGE_PRESETS.map((p) => (
            <Button
              key={p.value}
              size="xs"
              variant={preset === p.value ? "default" : "outline"}
              onClick={() => onSelectPreset(p.value)}
              aria-pressed={preset === p.value}
            >
              {p.label}
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {loading ? (
            <Spinner className="size-3.5" />
          ) : (
            <span className="text-xs text-muted-foreground tabular-nums">
              {from} → {to}
            </span>
          )}
          {refresh ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="xs" onClick={refresh} disabled={loading}>
                  <RefreshCw className="size-3" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Reload daily aggregates</TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="size-3.5" />
          <span className="font-medium">Failed to refresh:</span>
          <span className="text-muted-foreground">{error}</span>
        </div>
      ) : null}

      {isEmpty ? (
        <Card>
          <CardContent className="py-8 text-center text-xs text-muted-foreground">
            No usage history yet. Daily aggregates appear after the first UTC midnight downsampling
            job runs.
          </CardContent>
        </Card>
      ) : (
        <HeatmapGrid days={days} byDay={byDay} loading={loading} onSelectDay={onSelectDay} />
      )}

      <HeatmapBrush rows={rows ?? []} from={from} to={to} onBrushRange={onBrushRange} />

      <HeatmapLegend />
    </div>
  );
}

interface HeatmapGridProps {
  days: string[];
  byDay: Map<string, UsageDailyRow>;
  loading: boolean;
  onSelectDay: (dayUtc: string) => void;
}

function HeatmapGrid({ days, byDay, loading, onSelectDay }: HeatmapGridProps): React.JSX.Element {
  // Group days into weeks (columns of 7) for a GitHub-contributions layout.
  // The first week is left-padded so day 0 aligns to its weekday column.
  const weeks = useMemo(() => {
    if (days.length === 0) return [];
    const firstDow = new Date(`${days[0]}T00:00:00.000Z`).getUTCDay(); // 0=Sun
    const padded: (string | null)[] = Array(firstDow).fill(null);
    padded.push(...days);
    const cols: (string | null)[][] = [];
    for (let i = 0; i < padded.length; i += 7) {
      cols.push(padded.slice(i, i + 7));
    }
    return cols;
  }, [days]);

  return (
    <Card>
      <CardContent className="px-3 py-3">
        <ScrollArea className="w-full" horizontal>
          <div className="flex gap-3">
            {/* Weekday labels */}
            <div className="grid grid-rows-7 gap-1 text-[0.625rem] text-muted-foreground">
              <span className="leading-5">Sun</span>
              <span className="leading-5" />
              <span className="leading-5">Mon</span>
              <span className="leading-5" />
              <span className="leading-5">Wed</span>
              <span className="leading-5" />
              <span className="leading-5">Fri</span>
              <span className="leading-5" />
            </div>
            {/* Heatmap cells */}
            <div className="flex gap-1">
              {weeks.map((week, wi) => (
                // Week columns are positional (Sun–Sat grid); index is the stable identity.
                // biome-ignore lint/suspicious/noArrayIndexKey: weeks are positional grid columns
                <div key={`week-${wi}`} className="grid grid-rows-7 gap-1">
                  {week.map((day, di) => {
                    if (day === null) {
                      return (
                        <div
                          // Padding cells are positional within their week column.
                          // biome-ignore lint/suspicious/noArrayIndexKey: positional padding in a fixed 7-row grid
                          key={`pad-${wi}-${di}`}
                          className="size-4"
                          aria-hidden
                        />
                      );
                    }
                    const row = byDay.get(day);
                    return (
                      <DayCell
                        key={day}
                        day={day}
                        row={row}
                        loading={loading}
                        onSelectDay={onSelectDay}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}

interface DayCellProps {
  day: string;
  row: UsageDailyRow | undefined;
  loading: boolean;
  onSelectDay: (dayUtc: string) => void;
}

function DayCell({ day, row, loading, onSelectDay }: DayCellProps): React.JSX.Element {
  const level = activityLevel(row);
  const degradation = degradationState(row);
  const thickness = borderThickness(row);
  const completeness = row?.day_completeness ?? "missing";
  const isMissing = completeness === "missing" || !row;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid={loading ? undefined : `heatmap-day-cell-${day}`}
          data-day={day}
          data-activity-level={level}
          data-degradation={degradation}
          data-border-thickness={thickness}
          data-completeness={completeness}
          aria-label={`Usage heatmap day ${day}`}
          disabled={loading}
          onClick={() => onSelectDay(day)}
          className={cn(
            "size-4 rounded-[3px] border transition-colors",
            ACTIVITY_BG[level],
            DEGRADATION_BORDER[degradation],
            thicknessClass(thickness),
            // Missing days: hatched overlay so the calendar shows holes
            // distinctly from "zero activity but data exists".
            isMissing &&
              "bg-[repeating-linear-gradient(45deg,transparent,transparent_2px,hsl(var(--muted-foreground)/0.25)_2px,hsl(var(--muted-foreground)/0.25)_4px)]",
            "hover:ring-2 hover:ring-ring/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          )}
        />
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-[280px] text-xs">
        <DayTooltip day={day} row={row} />
      </TooltipContent>
    </Tooltip>
  );
}

function DayTooltip({
  day,
  row,
}: {
  day: string;
  row: UsageDailyRow | undefined;
}): React.JSX.Element {
  if (!row) {
    return (
      <div className="space-y-1">
        <div className="font-medium">{day}</div>
        <div className="text-background/70">No data (missing day)</div>
      </div>
    );
  }
  return (
    <div className="space-y-1">
      <div className="font-medium">{day}</div>
      <div className="text-background/70">
        Completeness: <span className="font-mono">{row.day_completeness}</span>
      </div>
      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
        <span>Activity:</span>
        <span className="text-right font-mono">{fmtMinutes(row.accumulated_active_minutes)}</span>
        <span>Observed span:</span>
        <span className="text-right font-mono">{fmtMinutes(row.utc_clock_span_minutes)}</span>
        <span>Cache hit:</span>
        <span className="text-right font-mono">{fmtPct(row.cache_hit_rate_avg)}</span>
        <span>Degradation:</span>
        <span className="text-right">{DEGRADATION_LABEL[degradationState(row)]}</span>
      </div>
      {(row.priority_ban_total_duration_ms ?? 0) > 0 ||
      (row.service_mode_ban_total_duration_ms ?? 0) > 0 ? (
        <div className="border-t border-border pt-1 text-background/70">
          Priority ban: {fmtMinutes((row.priority_ban_total_duration_ms ?? 0) / 60000)}
          <br />
          Service ban: {fmtMinutes((row.service_mode_ban_total_duration_ms ?? 0) / 60000)}
        </div>
      ) : null}
    </div>
  );
}

function HeatmapLegend(): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-3 text-[0.625rem] text-muted-foreground">
      <div className="flex items-center gap-1">
        <span>Less</span>
        <span className={cn("size-3 rounded-[2px] border", ACTIVITY_BG[0])} />
        <span className={cn("size-3 rounded-[2px] border", ACTIVITY_BG[1])} />
        <span className={cn("size-3 rounded-[2px] border", ACTIVITY_BG[2])} />
        <span className={cn("size-3 rounded-[2px] border", ACTIVITY_BG[3])} />
        <span>More</span>
      </div>
      <div className="flex items-center gap-1">
        <Info className="size-3" />
        <span>Border = degradation:</span>
        <Badge variant="outline" size="sm" className="border-yellow-500">
          priority
        </Badge>
        <Badge variant="outline" size="sm" className="border-orange-500">
          service
        </Badge>
        <Badge variant="outline" size="sm" className="border-red-600">
          both
        </Badge>
      </div>
    </div>
  );
}

interface HeatmapBrushProps {
  rows: UsageDailyRow[];
  from: string;
  to: string;
  onBrushRange: (from: string, to: string) => void;
}

/** Brush-to-zoom control (decision 16). Renders a sparkline of daily
 *  activity with a Recharts `Brush` overlay. Dragging the brush fires
 *  `onBrushRange(from, to)` with the selected date window so the parent
 *  can zoom the heatmap. */
function HeatmapBrush({ rows, from, to, onBrushRange }: HeatmapBrushProps): React.JSX.Element {
  // Build a point per day in [from, to]. The brush indexes into this
  // array; we map brush start/end indices back to YYYY-MM-DD.
  const points = useMemo(() => {
    const all = enumerateDays(from, to);
    const byDay = indexByDay(rows);
    return all.map((day) => ({
      day,
      activity: byDay.get(day)?.accumulated_active_minutes ?? 0,
    }));
  }, [rows, from, to]);

  const total = dayCount(from, to);

  const [brushStart, setBrushStart] = useState(0);
  const [brushEnd, setBrushEnd] = useState(Math.max(0, total - 1));

  useEffect(() => {
    const max = Math.max(0, dayCount(from, to) - 1);
    setBrushStart(0);
    setBrushEnd(max);
  }, [from, to]);

  return (
    <div data-testid="heatmap-brush" className="w-full">
      <ChartFrame className="h-[72px]">
        <ResponsiveAreaChart
          points={points}
          startIndex={brushStart}
          endIndex={brushEnd}
          onBrushRange={onBrushRange}
        />
      </ChartFrame>
    </div>
  );
}

interface ResponsiveAreaChartProps {
  points: Array<{ day: string; activity: number }>;
  startIndex: number;
  endIndex: number;
  onBrushRange: (from: string, to: string) => void;
}

function ResponsiveAreaChart({
  points,
  startIndex,
  endIndex,
  onBrushRange,
}: ResponsiveAreaChartProps): React.JSX.Element {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={points} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
        <defs>
          <linearGradient id="heatmap-brush-activity" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="hsl(var(--chart-2))" stopOpacity={0.7} />
            <stop offset="100%" stopColor="hsl(var(--chart-2))" stopOpacity={0.1} />
          </linearGradient>
        </defs>
        <XAxis dataKey="day" hide />
        <YAxis hide domain={[0, "dataMax"]} />
        <Area
          type="monotone"
          dataKey="activity"
          stroke="hsl(var(--chart-2))"
          strokeWidth={1.5}
          fill="url(#heatmap-brush-activity)"
          isAnimationActive={false}
        />
        <Brush
          dataKey="day"
          height={24}
          stroke="hsl(var(--border))"
          fill="hsl(var(--muted))"
          travellerWidth={8}
          startIndex={startIndex}
          endIndex={endIndex}
          onChange={(payload) => {
            if (!payload || payload.startIndex == null || payload.endIndex == null) return;
            const from = points[payload.startIndex]?.day;
            const to = points[payload.endIndex]?.day;
            if (from && to) onBrushRange(from, to);
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}
