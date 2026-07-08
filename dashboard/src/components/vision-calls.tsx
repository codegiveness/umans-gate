import { AlertCircle, Eye, RotateCcw, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Loader } from "@/components/ui/loader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVisionCalls } from "@/hooks/use-vision-calls";
import { fmtDate, fmtSize, fmtTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { VisionCallRecord } from "@/types/vision";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  ok: "secondary",
  cache_hit: "secondary",
  empty: "destructive",
  http_error: "destructive",
  fetch_error: "destructive",
  parse_error: "destructive",
  timeout: "destructive",
  skipped: "outline",
};

const STATUS_TIP: Record<string, string> = {
  ok: "Completed successfully",
  cache_hit: "Served from cache — no upstream call",
  empty: "No image content found",
  http_error: "Upstream returned an HTTP error",
  fetch_error: "Network failure — could not reach upstream",
  parse_error: "Response could not be parsed",
  timeout: "Request timed out",
  skipped: "Vision processing was skipped",
};

export function VisionCalls() {
  const { records, loading, error, refresh, clear } = useVisionCalls();

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          Vision Calls <Badge variant="secondary">{records.length}</Badge>
        </h2>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={clear} disabled={records.length === 0}>
              <Trash2 className="size-3.5 mr-1" />
              Clear
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Clear all vision call records</TooltipContent>
        </Tooltip>
      </header>

      {loading && records.length === 0 ? (
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
                <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                Retry
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Retry loading vision calls</TooltipContent>
          </Tooltip>
        </div>
      ) : records.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
          <Eye className="h-12 w-12 text-muted-foreground/40" />
          <p className="text-sm font-medium">No vision calls recorded</p>
          <p className="text-xs">
            Vision calls appear here when the proxy intercepts image-bearing requests.
          </p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 px-4 py-3">
            {records.map((rec) => (
              <VisionCallCard key={rec.id} record={rec} />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function VisionCallCard({ record }: { record: VisionCallRecord }) {
  const isOk = record.status === "ok" || record.status === "cache_hit";

  return (
    <Card>
      <CardContent className="p-3 flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant={STATUS_VARIANT[record.status] ?? "outline"}>{record.status}</Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[220px]">
                {record.status} — {STATUS_TIP[record.status] ?? "unknown status"}
              </TooltipContent>
            </Tooltip>
            <span className="text-sm font-mono text-muted-foreground">#{record.id}</span>
            {record.captureId !== null && (
              <span className="text-xs text-muted-foreground">capture #{record.captureId}</span>
            )}
          </div>
          <span className="text-xs text-muted-foreground">{fmtDate(record.timestamp)}</span>
        </div>

        <div className="flex items-center gap-3 text-sm">
          <span className="font-mono">{record.model}</span>
          <span className="text-muted-foreground">{fmtSize(record.imageSize)}</span>
          <span className="text-muted-foreground">{fmtTime(record.latencyMs)}</span>
          {record.httpStatus !== null && (
            <span
              className={cn(
                "font-mono",
                record.httpStatus < 400 ? "text-foreground" : "text-destructive",
              )}
            >
              HTTP {record.httpStatus}
            </span>
          )}
        </div>

        {record.error && (
          <div
            role="alert"
            className="text-sm text-destructive bg-destructive/10 rounded px-2 py-1 font-mono break-all"
          >
            {record.error}
          </div>
        )}

        {record.description && (
          <div
            className={cn(
              "text-sm rounded px-2 py-1 break-words whitespace-pre-wrap",
              isOk ? "bg-muted" : "bg-muted/50",
            )}
          >
            {record.description}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
