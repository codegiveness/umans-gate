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

import { fmtMs, fmtPct, fmtTps } from "./perf-utils";

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
          <TooltipContent side="bottom">Re-compute performance percentiles</TooltipContent>
        </Tooltip>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col p-4">
          {loading && !stats ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader className="h-auto" />
            </div>
          ) : error ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <AlertCircle className="h-12 w-12 text-destructive" />
              <p className="text-sm font-medium text-destructive">Something went wrong</p>
              <p className="text-xs">{error}</p>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={refresh}>
                    Retry
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Retry loading performance stats</TooltipContent>
              </Tooltip>
            </div>
          ) : stats === null || stats.length === 0 ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <Inbox className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm font-medium">No performance data yet</p>
              <p className="text-xs">Send requests through the proxy to see stats.</p>
            </div>
          ) : (
            <div className="space-y-4">
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
  return (
    <Card>
      <CardContent className="p-4">
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
            primaryLabel="p50"
            primary={fmtMs(row.ttft_p50)}
            sub={`p10 ${fmtMs(row.ttft_p10)} · p95 ${fmtMs(row.ttft_p95)} · μ ${fmtMs(row.ttft_mean)}`}
          />
          <StatTile
            icon={<Gauge className="h-3.5 w-3.5" />}
            label="TPS"
            primaryLabel="p50"
            primary={fmtTps(row.tps_p50)}
            sub={`p10 ${fmtTps(row.tps_p10)} · p95 ${fmtTps(row.tps_p95)} · μ ${fmtTps(row.tps_mean)}`}
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
            sub={`cached ${fmtTokensCompact(row.total_cache_read_tokens)}`}
          />
          <StatTile
            icon={<Activity className="h-3.5 w-3.5" />}
            label="Cached"
            primary={fmtPct(row.cached_pct)}
            sub={`${fmtTokensCompact(row.total_cache_read_tokens)} tokens`}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function StatTile({
  icon,
  label,
  primaryLabel,
  primary,
  sub,
}: {
  icon: React.ReactNode;
  label: string;
  primaryLabel?: string;
  primary: string;
  sub: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums leading-tight">{primary}</span>
        {primaryLabel && (
          <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground/70">
            {primaryLabel}
          </span>
        )}
      </div>
      <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{sub}</div>
    </div>
  );
}
