import { AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

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
import { type RangePreset, addDays, dayAgeDays, presetRange, todayUtc } from "@/lib/usage-heatmap";
import { findDailyRow } from "@/lib/usage-timeline-old";
import type { UsageSampleRow } from "@/types";

/** Default raw-sample retention (days) when the config endpoint hasn't
 *  loaded or doesn't surface the field. Matches the backend default. */
const DEFAULT_RAW_RETENTION_DAYS = 7;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function UsageTab() {
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

function TodaySamplesSection({
  samples,
  loading,
  error,
  onRefresh,
}: TodaySamplesSectionProps): JSX.Element {
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

function SamplesTable({ samples }: { samples: UsageSampleRow[] }): JSX.Element {
  return (
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
        {samples.map((row) => (
          <TableRow key={row.id}>
            <TableCell className="tabular-nums whitespace-nowrap">
              {fmtTime(row.fetched_at)}
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
  );
}
