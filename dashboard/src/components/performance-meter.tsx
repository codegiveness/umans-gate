import { Activity, AlertCircle, Cpu, Gauge, Inbox, Zap } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader } from "@/components/ui/loader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { usePerformanceStats } from "@/hooks/use-performance-stats";
import { fmtTokensCompact } from "@/lib/format";
import type { PerformanceStatsRow } from "@/types";

import {
  fmtAvgLabel,
  fmtAvgMs,
  fmtAvgTps,
  fmtPct,
  fmtPercentiles,
  fmtThinkingPct,
  fmtTpsPercentiles,
} from "./perf-utils";

export function PerformanceMeter() {
  const { stats, loading, error, refresh } = usePerformanceStats();

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Performance</h2>
          {stats && (
            <span className="text-xs text-muted-foreground">
              {stats.length} model{stats.length === 1 ? "" : "s"}
            </span>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              {loading ? (
                <Spinner className="mr-1.5 size-3.5" />
              ) : (
                <Activity className="mr-1.5 h-3.5 w-3.5" />
              )}
              Refresh
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Re-compute performance statistics</TooltipContent>
        </Tooltip>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col p-4">
          {loading && !stats ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader className="h-auto" />
            </div>
          ) : stats === null || stats.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <Inbox className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm font-medium">
                {error ? "Something went wrong" : "No performance data yet"}
              </p>
              {error ? (
                <>
                  <p className="text-xs">{error}</p>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <Button variant="outline" size="sm" onClick={refresh}>
                        Retry
                      </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">Retry loading performance stats</TooltipContent>
                  </Tooltip>
                </>
              ) : (
                <p className="text-xs">Send requests through the proxy to see stats.</p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  <span className="font-medium">Failed to refresh:</span>
                  <span className="text-muted-foreground">{error}</span>
                </div>
              )}
              {stats.map((row) => (
                <ModelPerfCard key={row.model} row={row} />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function ModelPerfCard({ row }: { row: PerformanceStatsRow }) {
  const thinkingPct = fmtThinkingPct(row.total_thinking_tokens, row.total_output_tokens);
  return (
    <Card>
      <CardContent className="px-4 py-0">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-semibold" title={row.model}>
              {row.model}
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {row.provider} · {row.streaming_count} streaming
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger render={<span className="shrink-0 inline-flex" />}>
              <Badge variant="secondary">
                {row.request_count} req{row.request_count === 1 ? "" : "s"}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="left" className="max-w-[240px]">
              {row.request_count} requests — {row.streaming_count} streamed ·{" "}
              {row.request_count - row.streaming_count} non-streaming
            </TooltipContent>
          </Tooltip>
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          <StatTile
            icon={<Zap className="h-3.5 w-3.5" />}
            label="TTFT"
            primary={fmtAvgMs(row.ttft_mean)}
            primaryDetail={fmtAvgLabel(row.ttft_mean)}
            sub2={fmtPercentiles(row.ttft_p10, row.ttft_p50, row.ttft_p95)}
          />
          <StatTile
            icon={<Gauge className="h-3.5 w-3.5" />}
            label="TPS"
            primary={fmtAvgTps(row.tps_mean)}
            primaryDetail={fmtAvgLabel(row.tps_mean)}
            sub2={fmtTpsPercentiles(row.tps_p10, row.tps_p50, row.tps_p95)}
          />
          <StatTile
            icon={<Cpu className="h-3.5 w-3.5" />}
            label="Total In"
            primary={fmtTokensCompact(row.total_input_tokens)}
            sub={`${row.provider === "anthropic" ? "incl. cache" : "prompt"}`}
          />
          <StatTile
            icon={<Cpu className="h-3.5 w-3.5" />}
            label="Total Out"
            primary={fmtTokensCompact(row.total_output_tokens)}
            sub={
              row.total_thinking_tokens > 0
                ? `${fmtTokensCompact(row.total_thinking_tokens)} thinking${thinkingPct ? ` (${thinkingPct})` : ""}`
                : undefined
            }
          />
          <StatTile
            icon={<Activity className="h-3.5 w-3.5" />}
            label="Cache Hit"
            primary={fmtPct(row.cached_pct)}
            sub={`${fmtTokensCompact(row.total_cache_read_tokens)} cached`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function StatTile({
  icon,
  label,
  primary,
  primaryDetail,
  sub,
  sub2,
}: {
  icon: React.ReactNode;
  label: string;
  primary: string;
  primaryDetail?: string;
  sub?: string;
  sub2?: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums leading-tight">{primary}</span>
        {primaryDetail && (
          <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/80 tabular-nums">
            {primaryDetail}
          </span>
        )}
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{sub}</div>}
      {sub2 && <div className="text-xs text-muted-foreground/70 tabular-nums">{sub2}</div>}
    </div>
  );
}
