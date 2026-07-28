import { AlertCircle, ArrowLeft, ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { PenaltyBadge } from "@/components/penalty-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader } from "@/components/ui/loader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { UsageHeatmap } from "@/components/usage-heatmap";
import { UsageTimeline } from "@/components/usage-timeline";
import { UsageTimelineOld } from "@/components/usage-timeline-old";
import { useConfig } from "@/hooks/use-config";
import { useUsageDaily } from "@/hooks/use-usage-daily";
import { useUsageDay } from "@/hooks/use-usage-day";
import { useUsageHistory } from "@/hooks/use-usage-history";
import { useUsageWs } from "@/hooks/use-usage-ws";
import { badgeGold, budgetTier } from "@/lib/badge-colors";
import { fmtDurationUntil, fmtUtcTime } from "@/lib/format";
import { mergePenaltyInput } from "@/lib/gate-health";
import { addDays, dayAgeDays, presetRange, type RangePreset, todayUtc } from "@/lib/usage-heatmap";
import { findDailyRow } from "@/lib/usage-timeline-old";
import type { PriorityBudgetEntry, UsageSampleRow, UsageSnapshot } from "@/types";

/** Default raw-sample retention (days) when the config endpoint hasn't
 *  loaded or doesn't surface the field. Matches the backend default. */
const DEFAULT_RAW_RETENTION_DAYS = 7;

export function UsageTab({ usageSnapshot = null }: { usageSnapshot?: UsageSnapshot | null }) {
  const [preset, setPreset] = useState<RangePreset>("30d");
  // `zoomRange` is set by the brush; null = use the preset window.
  const [zoomRange, setZoomRange] = useState<{ from: string; to: string } | null>(null);
  // The currently selected day (drill-down trigger for ticket 05's timeline).
  // Defaults to today so the timeline is visible on first render.
  const [selectedDay, setSelectedDay] = useState<string>(() => todayUtc());

  // The heatmap fetches the preset window. For "all" we use a wide window
  // (2 years) since the daily table is small (~730 rows max for 2y).
  const presetWindow = useMemo(() => {
    if (preset === "all") {
      // 2-year cap; "all" really means "as far back as we have data".
      const from = addDays(todayUtc(), -2 * 365 + 1);
      return { from, to: todayUtc() };
    }
    return presetRange(preset, null);
  }, [preset]);

  const visibleWindow = zoomRange ?? presetWindow;

  // Fetch daily rows for the preset window (not the zoomed sub-range) so
  // the brush sparkline always has the full preset context.
  const {
    rows: dailyRows,
    loading: dailyLoading,
    error: dailyError,
    refresh: dailyRefresh,
  } = useUsageDaily(presetWindow.from, presetWindow.to);

  const { config } = useConfig();
  const rawRetentionDays = config?.usage_raw_retention_days ?? DEFAULT_RAW_RETENTION_DAYS;

  const { samples, loading, error, refresh } = useUsageHistory("today");

  // Timeline data for the selected day (ticket 05 recent + ticket 06 old).
  const {
    samples: daySamples,
    events: dayEvents,
    daily30Day,
    loading: dayLoading,
    error: dayError,
    refresh: dayRefresh,
  } = useUsageDay(selectedDay);

  // Ticket 06: day-age switch. Old days (>retention) render from daily +
  // events with a dashed step-function; recent days render from raw samples
  // (ticket 05).
  const selectedDayAge = useMemo(() => dayAgeDays(selectedDay), [selectedDay]);
  const isOldDay = selectedDayAge > rawRetentionDays;
  const selectedDailyRow = useMemo(
    () => findDailyRow(daily30Day, selectedDay),
    [daily30Day, selectedDay],
  );

  const handleSelectPreset = (p: RangePreset) => {
    setPreset(p);
    setZoomRange(null);
  };

  const handleBrushRange = (from: string, to: string) => {
    setZoomRange({ from, to });
  };

  const handleSelectDay = (dayUtc: string) => {
    setSelectedDay(dayUtc);
  };

  const handleBackToToday = () => {
    // Reset to today so the timeline view returns to the default day.
    setSelectedDay(todayUtc());
  };

  // Live WS refresh (ticket 07): on a usage-sample/usage-event broadcast,
  // re-fetch the affected view. The heatmap refreshes for any day (events
  // affect the daily degradation burden; samples affect the heatmap only
  // after downsampling, but refresh is cheap). The timeline + today-list
  // refresh only when the message is for the currently-selected day.
  const todayStr = useMemo(() => todayUtc(), []);
  useUsageWs({
    onSample: (detail) => {
      // Heatmap is always relevant (a new sample means today's activity).
      dailyRefresh();
      if (detail.dayUtc === selectedDay) {
        dayRefresh();
      }
      if (detail.dayUtc === todayStr) {
        refresh();
      }
    },
    onEvent: (detail) => {
      // Events affect both the heatmap (degradation burden) and the
      // selected day's timeline if it matches.
      dailyRefresh();
      if (detail.dayUtc === selectedDay) {
        dayRefresh();
      }
    },
  });
  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Usage</h2>
          {selectedDay ? (
            <Badge variant="outline" size="sm">
              {selectedDay}
            </Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={dayRefresh} disabled={dayLoading}>
                {dayLoading ? (
                  <Spinner className="mr-1.5 size-3.5" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                Refresh timeline
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Reload usage samples + events for the selected day
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
                {loading ? (
                  <Spinner className="mr-1.5 size-3.5" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                Refresh samples
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Reload today's usage samples</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-4 p-4">
          <PenaltyBadge input={mergePenaltyInput(null, usageSnapshot)} />
          {usageSnapshot?.priorityBudget?.length ? (
            <PriorityBudgetCards entries={usageSnapshot.priorityBudget} />
          ) : null}

          {dailyError ? (
            <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <AlertCircle className="h-3.5 w-3.5" />
              <span className="font-medium">Daily load failed:</span>
              <span className="text-muted-foreground">{dailyError}</span>
            </div>
          ) : null}

          <UsageHeatmap
            rows={dailyRows}
            from={visibleWindow.from}
            to={visibleWindow.to}
            preset={preset}
            loading={dailyLoading}
            error={dailyError}
            refresh={dailyRefresh}
            onSelectPreset={handleSelectPreset}
            onSelectDay={handleSelectDay}
            onBrushRange={handleBrushRange}
          />

          {zoomRange ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>
                Zoomed: {zoomRange.from} → {zoomRange.to}
              </span>
              <Button size="xs" variant="outline" onClick={() => setZoomRange(null)}>
                Reset zoom
              </Button>
            </div>
          ) : null}

          <div className="flex items-center justify-between">
            <Button
              size="xs"
              variant="ghost"
              onClick={handleBackToToday}
              disabled={selectedDay === todayUtc()}
            >
              <ArrowLeft className="size-3" />
              Back to today
            </Button>
          </div>

          {isOldDay ? (
            <UsageTimelineOld
              dayUtc={selectedDay}
              daily={selectedDailyRow}
              events={dayEvents}
              daily30Day={daily30Day}
              loading={dayLoading}
              error={dayError}
            />
          ) : (
            <UsageTimeline
              dayUtc={selectedDay}
              samples={daySamples}
              events={dayEvents}
              daily30Day={daily30Day}
              loading={dayLoading}
              error={dayError}
            />
          )}

          <TodaySamplesSection
            samples={samples}
            loading={loading}
            error={error}
            onRefresh={refresh}
          />
        </div>
      </ScrollArea>
    </div>
  );
}

interface TodaySamplesSectionProps {
  samples: UsageSampleRow[] | null;
  loading: boolean;
  error: string | null;
  onRefresh: () => void;
}

const TIER_BAR_CLASS: Record<"blue" | "amber" | "red", string> = {
  blue: "bg-primary",
  amber: "bg-amber-500",
  red: "bg-destructive",
};

function PriorityBudgetCards({ entries }: { entries: PriorityBudgetEntry[] }): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map((entry) => {
        const tier = budgetTier(entry);
        const barClass = TIER_BAR_CLASS[tier];
        const resets = fmtDurationUntil(entry.resetsAt);
        return (
          <Card key={entry.category}>
            <CardContent className="px-4 py-3">
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{entry.label}</h3>
                <Badge variant="secondary" size="sm" className={badgeGold}>
                  {entry.mode.toLowerCase()}
                </Badge>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full rounded-full transition-all ${barClass}`}
                  style={{ width: `${Math.min(entry.usedPct, 100)}%` }}
                />
              </div>
              <div className="mt-1.5 flex items-center justify-between gap-2">
                <span
                  className={`text-xs tabular-nums ${entry.overBudgetToday ? "text-destructive" : ""}`}
                >
                  {entry.usedPct}%
                </span>
                {entry.overBudgetToday && resets ? (
                  <span className="text-xs text-destructive">resets in {resets}</span>
                ) : resets ? (
                  <span className="text-xs text-muted-foreground">resets in {resets}</span>
                ) : null}
              </div>
              {entry.models.length > 0 ? (
                <p className="mt-1.5 text-xs text-muted-foreground">{entry.models.join(", ")}</p>
              ) : null}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

function TodaySamplesSection({
  samples,
  loading,
  error,
  onRefresh,
}: TodaySamplesSectionProps): React.JSX.Element {
  return (
    <Card>
      <CardContent className="px-4 py-0">
        <div className="flex items-center justify-between py-3">
          <h3 className="text-sm font-semibold">Today&apos;s Samples</h3>
          {samples && samples.length > 0 ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              {samples.length} sample{samples.length === 1 ? "" : "s"}
            </span>
          ) : null}
        </div>

        {loading && !samples ? (
          <div className="flex items-center justify-center py-8">
            <Loader className="h-auto" />
          </div>
        ) : samples === null ? (
          <div className="flex flex-col items-center justify-center gap-3 py-8 text-center text-muted-foreground">
            <p className="text-sm font-medium">
              {error ? "Something went wrong" : "No usage samples yet"}
            </p>
            {error ? (
              <>
                <p className="text-xs">{error}</p>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button variant="outline" size="sm" onClick={onRefresh}>
                      Retry
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="top">Retry loading usage samples</TooltipContent>
                </Tooltip>
              </>
            ) : (
              <p className="text-xs">
                Set <code>umans_api_key</code> and the proxy will poll /v1/usage periodically.
              </p>
            )}
          </div>
        ) : samples.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            No usage samples recorded yet. Wait for the next /v1/usage poll.
          </div>
        ) : (
          <SamplesTable samples={samples} />
        )}
      </CardContent>
    </Card>
  );
}

const SAMPLES_PAGE_SIZE = 10;

function SamplesTable({ samples }: { samples: UsageSampleRow[] }): React.JSX.Element {
  const totalPages = Math.max(1, Math.ceil(samples.length / SAMPLES_PAGE_SIZE));
  const [page, setPage] = useState(0);
  const clampedPage = Math.min(page, totalPages - 1);
  const startIdx = clampedPage * SAMPLES_PAGE_SIZE;
  const pageRows = useMemo(
    () => samples.slice(startIdx, startIdx + SAMPLES_PAGE_SIZE),
    [samples, startIdx],
  );

  return (
    <div className="flex flex-col gap-3">
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="text-left text-muted-foreground hover:bg-transparent">
            <TableHead>Time</TableHead>
            <TableHead>Plan</TableHead>
            <TableHead>Soft</TableHead>
            <TableHead>Hard</TableHead>
            <TableHead>In Window</TableHead>
            <TableHead>Concurrent</TableHead>
            <TableHead>Tokens In</TableHead>
            <TableHead>Tokens Out</TableHead>
            <TableHead>Service</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pageRows.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="tabular-nums whitespace-nowrap">
                {fmtUtcTime(row.fetched_at)}
              </TableCell>
              <TableCell className="whitespace-nowrap">
                {row.plan}
                {row.priority_low === 1 && (
                  <Badge variant="outline" size="sm" className="ml-1">
                    low
                  </Badge>
                )}
              </TableCell>
              <TableCell className="tabular-nums">{row.concurrency_soft_limit}</TableCell>
              <TableCell className="tabular-nums">{row.concurrency_hard_cap}</TableCell>
              <TableCell className="tabular-nums">{row.requests_in_window}</TableCell>
              <TableCell className="tabular-nums">{row.concurrent_sessions}</TableCell>
              <TableCell className="tabular-nums">{row.tokens_in}</TableCell>
              <TableCell className="tabular-nums">{row.tokens_out}</TableCell>
              <TableCell className="whitespace-nowrap">{row.service_mode_current}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {totalPages > 1 ? (
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-xs text-muted-foreground tabular-nums">
            Page {clampedPage + 1} of {totalPages} ({samples.length} samples)
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="outline"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={clampedPage === 0}
            >
              <ChevronLeft className="size-3" />
              Prev
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
              disabled={clampedPage >= totalPages - 1}
            >
              Next
              <ChevronRight className="size-3" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
