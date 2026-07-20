import { Eye } from "lucide-react";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { badgeInfo, badgeSuccess } from "@/lib/badge-colors";
import {
  fmtCachePct,
  fmtSize,
  fmtTime,
  fmtTokensCompact,
  fmtTps,
  fmtTtft,
  fmtUtcDateTime,
  fmtUtcTime,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CaptureSummary } from "@/types";
import { StatusBadge } from "./status-badge";

interface CaptureRowItemProps {
  capture: CaptureSummary;
  selected: boolean;
  isActive: boolean;
  optionId: string;
  onActivate: () => void;
}

/**
 * Live age counter for in-flight captures. Ticks every 1s showing whole
 * seconds elapsed since `started_at`. Sub-second precision is noise while
 * a request is still running.
 */
function useLiveAge(startedAt: number | null, isRunning: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isRunning || startedAt == null) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isRunning, startedAt]);
  if (!isRunning || startedAt == null) return null;
  return Math.max(0, now - startedAt);
}

function fmtAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m${rem}s`;
}

/**
 * Minimal tooltip wrapper for inline elements in capture rows. Keeps the
 * tooltip content shape consistent: a bold label + optional muted detail.
 */
function RowTip({
  tip,
  children,
}: {
  tip: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{children}</TooltipTrigger>
      <TooltipContent side="top" className="max-w-[220px]">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

export function CaptureRowItem({
  capture: c,
  selected,
  isActive,
  optionId,
  onActivate,
}: CaptureRowItemProps) {
  const isRunning = c.state === "enqueued" || c.state === "streaming";
  const liveAge = useLiveAge(c.started_at, isRunning);

  return (
    <div
      // biome-ignore lint/a11y/useSemanticElements: ARIA option role for virtualized listbox pattern
      role="option"
      id={optionId}
      aria-selected={selected}
      tabIndex={-1}
      onClick={onActivate}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onActivate();
        }
      }}
      className={cn(
        "cursor-pointer border-b border-border px-4 py-3 w-full transition-colors hover:bg-accent overflow-hidden",
        selected && "bg-accent",
        isActive && !selected && "bg-accent/50",
      )}
    >
      {/* Row 1: method + status + protocol + transfer + timestamp */}
      <div className="flex items-center gap-1.5 overflow-hidden">
        <RowTip
          tip={
            <>
              Method <span className="font-mono">{c.method}</span>
            </>
          }
        >
          <span className="shrink-0 font-mono text-xs font-bold text-primary">{c.method}</span>
        </RowTip>
        <StatusBadge
          status={c.response_status}
          statusSource={c.status_source}
          gateReason={c.gate_reason}
          size="sm"
        />
        {c.is_vision && (
          <RowTip tip="Vision call — request included image input">
            <span className="inline-flex shrink-0 items-center text-muted-foreground">
              <Eye className="h-3.5 w-3.5" />
            </span>
          </RowTip>
        )}
        {c.state === "enqueued" && (
          <RowTip tip="Queued — waiting for a concurrency slot">
            <Badge variant="secondary" size="sm" className={badgeInfo}>
              queued
            </Badge>
          </RowTip>
        )}
        {c.state === "streaming" && (
          <RowTip tip="Running — upstream is streaming the response">
            <Badge variant="secondary" size="sm" className={badgeSuccess}>
              running
            </Badge>
          </RowTip>
        )}
        {c.is_sse && (
          <RowTip tip="SSE — upstream response is a stream">
            <Badge variant="secondary" size="sm">
              SSE
            </Badge>
          </RowTip>
        )}
        {c.upstream_protocol && (
          <RowTip
            tip={
              <>
                Upstream HTTP <span className="font-mono">{c.upstream_protocol}</span>
              </>
            }
          >
            <Badge variant="outline" size="sm">
              {c.upstream_protocol}
            </Badge>
          </RowTip>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums text-muted-foreground">
          <RowTip tip={<>Request size — {fmtSize(c.request_size)}</>}>
            <span>
              <span className="text-muted-foreground/70">↑</span>
              {fmtSize(c.request_size)}
            </span>
          </RowTip>
          <RowTip tip={<>Response size — {fmtSize(c.response_size)}</>}>
            <span>
              <span className="text-muted-foreground/70">↓</span>
              {fmtSize(c.response_size)}
            </span>
          </RowTip>
          <RowTip
            tip={
              c.started_at
                ? `Started ${fmtUtcDateTime(c.started_at)}${
                    c.finished_at ? ` · finished ${fmtUtcDateTime(c.finished_at)}` : ""
                  } · All times shown in UTC`
                : "Start time not recorded"
            }
          >
            <span className="text-muted-foreground/60">{fmtUtcTime(c.started_at)}</span>
          </RowTip>
        </span>
      </div>

      {/* Row 2: path (mono, truncated) */}
      <RowTip
        tip={
          <span className="font-mono break-all">
            {c.path}
            {c.model ? ` · ${c.model}` : ""}
          </span>
        }
      >
        <div className="mt-1 truncate font-mono text-xs text-foreground/80">
          {c.path}
          {c.model && <span className="text-muted-foreground"> · {c.model}</span>}
        </div>
      </RowTip>

      {/* Row 3: all metrics in one row */}
      <div className="mt-1.5 flex items-center gap-3 text-[11px] tabular-nums text-muted-foreground">
        {isRunning && liveAge != null ? (
          <RowTip tip="Age — time since request started (still running)">
            <span className="flex items-center gap-1 font-medium text-primary">
              <span
                className="inline-block h-1.5 w-1.5 rounded-full bg-primary animate-pulse"
                aria-hidden
              />
              {fmtAge(liveAge)}
            </span>
          </RowTip>
        ) : (
          <RowTip tip={<>Total time — {fmtTime(c.duration_ms) || "—"}</>}>
            <span>{fmtTime(c.duration_ms) || "—"}</span>
          </RowTip>
        )}
        {(!isRunning || c.ttft_ms != null) && (
          <RowTip tip="Time to first token — delay before first response token">
            <span>ttft {fmtTtft(c.ttft_ms)}</span>
          </RowTip>
        )}
        <RowTip
          tip={
            c.tps == null
              ? c.usage_missing
                ? "Tokens per second — usage data unavailable"
                : c.output_tokens == null || c.output_tokens <= 0
                  ? "Tokens per second — no output tokens"
                  : "Tokens per second — generation time too short to measure (< 1 s)"
              : "Tokens per second — output generation rate"
          }
        >
          <span>{fmtTps(c.tps)} t/s</span>
        </RowTip>
        <RowTip tip="Total input tokens — prompt tokens sent (incl. cache writes)">
          <span>in {fmtTokensCompact(c.total_input_tokens)}</span>
        </RowTip>
        <RowTip tip="Total output tokens — completion tokens received">
          <span>out {fmtTokensCompact(c.total_output_tokens)}</span>
        </RowTip>
        <RowTip tip="Cache read % — share of input from prompt cache">
          <span>cache {fmtCachePct(c.cache_read_tokens, c.total_input_tokens)}</span>
        </RowTip>
      </div>
    </div>
  );
}
