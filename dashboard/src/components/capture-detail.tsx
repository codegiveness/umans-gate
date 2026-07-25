import { AlertCircle, Check, Clock, Copy, RotateCcw, ScanSearch } from "lucide-react";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { BodyRenderer } from "@/components/body-renderer";
import { StatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { badgeSuccess } from "@/lib/badge-colors";
import { extractCacheTtl, fmtSize, fmtTime, fmtUtcDateTime, fmtUtcTime } from "@/lib/format";
import type { CaptureDetail } from "@/types";

const HeadersViewer = lazy(() =>
  import("@/components/headers-viewer").then((m) => ({ default: m.HeadersViewer })),
);

interface CaptureDetailProps {
  capture: CaptureDetail | null;
  isLoading: boolean;
  detailError: string | null;
  onCopy: (text: string) => Promise<boolean>;
  onCopyStatus?: (label: string) => void;
  onRetry: () => void;
}

type TabValue = "response" | "request" | "res-headers" | "req-headers";

const TAB_LABELS: Record<TabValue, string> = {
  response: "Response Body",
  request: "Request Body",
  "res-headers": "Response Headers",
  "req-headers": "Request Headers",
};

const TAB_TIPS: Record<TabValue, string> = {
  response: "Body returned by the upstream LLM",
  request: "Body sent to the upstream — full prompt",
  "res-headers": "HTTP response headers from upstream",
  "req-headers": "HTTP request headers sent to upstream",
};

export function CaptureDetailPanel({
  capture,
  isLoading,
  detailError,
  onCopy,
  onCopyStatus,
  onRetry,
}: CaptureDetailProps) {
  const [activeTab, setActiveTab] = useState<TabValue>("response");
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const didReportInitialRef = useRef(false);

  const copyLabel = useMemo(() => {
    if (copyStatus === "copied") return "Copied!";
    if (copyStatus === "failed") return "Failed";
    return "Copy";
  }, [copyStatus]);

  if (onCopyStatus && !didReportInitialRef.current) {
    didReportInitialRef.current = true;
    onCopyStatus(copyLabel);
  }

  const sourceMap = useMemo(() => {
    if (!capture) return {} as Record<TabValue, string | null>;
    return {
      response: capture.response_body,
      request: capture.request_body,
      "res-headers": capture.response_headers,
      "req-headers": capture.request_headers,
    };
  }, [capture]);

  const cacheTtl = useMemo(
    () => (capture ? extractCacheTtl(capture.request_body) : null),
    [capture],
  );

  async function handleCopy() {
    if (!capture) return;
    const ok = await onCopy(sourceMap[activeTab] ?? "");
    const nextStatus = ok ? "copied" : "failed";
    const nextLabel = ok ? "Copied!" : "Failed";
    setCopyStatus(nextStatus);
    onCopyStatus?.(nextLabel);
    setTimeout(() => {
      setCopyStatus("idle");
      onCopyStatus?.("Copy");
    }, 1200);
    const label = TAB_LABELS[activeTab];
    if (ok) {
      toast.success("Copied to clipboard", { description: label });
    } else {
      toast.error("Copy failed", { description: `Could not copy ${label.toLowerCase()}.` });
    }
  }

  if (isLoading) {
    return (
      <main
        aria-label="Capture detail"
        className="flex flex-1 flex-col items-center justify-center gap-3 overflow-hidden"
      >
        <Loader className="h-auto" />
        <p className="text-xs text-muted-foreground">Loading capture…</p>
      </main>
    );
  }

  if (!capture && detailError) {
    return (
      <main className="flex flex-1 flex-col overflow-hidden">
        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
            <AlertCircle className="h-12 w-12 text-destructive" />
            <p className="text-sm font-medium text-destructive">Couldn&apos;t load this capture</p>
            <p className="text-xs">{detailError}</p>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={onRetry}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Retry
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Retry loading capture detail</TooltipContent>
            </Tooltip>
          </div>
        </ScrollArea>
      </main>
    );
  }

  if (!capture) {
    return (
      <main className="flex flex-1 flex-col overflow-hidden">
        <ScrollArea className="flex-1 min-h-0">
          <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
            <ScanSearch className="h-12 w-12 text-muted-foreground/40" />
            <p className="text-sm font-medium">Select a capture to inspect</p>
            <p className="text-xs">
              Requests appear here automatically as they flow through the proxy.
            </p>
          </div>
        </ScrollArea>
      </main>
    );
  }

  return (
    <main className="flex flex-1 flex-col overflow-hidden">
      <header className="border-b border-border px-4 py-3">
        <div className="flex w-full items-start justify-between gap-3">
          <h2 className="break-all font-mono text-[15px] font-semibold leading-tight">
            {capture.method} {capture.path}
          </h2>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="outline" className="shrink-0" onClick={handleCopy}>
                {copyStatus === "copied" ? (
                  <Check className="mr-1.5 h-3.5 w-3.5" />
                ) : (
                  <Copy className="mr-1.5 h-3.5 w-3.5" />
                )}
                {copyLabel}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="left">Copy active tab content to clipboard</TooltipContent>
          </Tooltip>
        </div>
        <div className="mt-2 flex w-full flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <StatusBadge
            status={capture.response_status}
            statusSource={capture.status_source}
            gateReason={capture.gate_reason}
            size="sm"
          />
          {cacheTtl && (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="outline" size="sm">
                  <Clock className="mr-1 h-2.5 w-2.5" aria-hidden />
                  TTL {cacheTtl.ttl ?? "—"}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-[240px]">
                {cacheTtl.count} block{cacheTtl.count > 1 ? "s" : ""} stamped with ephemeral TTL
              </TooltipContent>
            </Tooltip>
          )}
          {capture.is_sse && (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="secondary" size="sm">
                  SSE
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top">Upstream response is an SSE stream</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex tabular-nums" />}>
              <span>
                ↑{fmtSize(capture.request_size)} ↓{fmtSize(capture.response_size)}
              </span>
            </TooltipTrigger>
            <TooltipContent side="top">
              ↑ {fmtSize(capture.request_size)} request · ↓ {fmtSize(capture.response_size)}{" "}
              response
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex tabular-nums" />}>
              <span>{fmtTime(capture.duration_ms)}</span>
            </TooltipTrigger>
            <TooltipContent side="top">Wall-clock duration from start to completion</TooltipContent>
          </Tooltip>
          {capture.incoming_protocol && (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="outline" size="sm">
                  in {capture.incoming_protocol}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top">HTTP version used by the client</TooltipContent>
            </Tooltip>
          )}
          {capture.upstream_protocol && (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="outline" size="sm">
                  out {capture.upstream_protocol}
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top">HTTP version used to reach upstream</TooltipContent>
            </Tooltip>
          )}
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex font-mono tabular-nums" />}>
              <span>{fmtUtcTime(capture.started_at)}</span>
            </TooltipTrigger>
            <TooltipContent side="top">
              {capture.started_at ? fmtUtcDateTime(capture.started_at) : "Not yet recorded"}
            </TooltipContent>
          </Tooltip>
          {capture.state === "streaming" && (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="secondary" size="sm" className={badgeSuccess}>
                  live
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="top">Response is still streaming</TooltipContent>
            </Tooltip>
          )}
        </div>
        <div className="mt-0.5 w-full break-all font-mono text-[11px] text-muted-foreground">
          {capture.url}
        </div>
      </header>

      <Tabs
        value={activeTab}
        onValueChange={(v) => setActiveTab(v as TabValue)}
        className="flex flex-1 flex-col overflow-hidden"
      >
        <TabsList className="mx-auto mt-2 w-fit">
          {(Object.keys(TAB_LABELS) as TabValue[]).map((tv) => (
            <Tooltip key={tv}>
              <TooltipTrigger render={<span />}>
                <TabsTrigger value={tv}>{TAB_LABELS[tv]}</TabsTrigger>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px]">
                {TAB_TIPS[tv]}
              </TooltipContent>
            </Tooltip>
          ))}
        </TabsList>

        <Suspense fallback={<Loader />}>
          <ScrollArea className="flex-1 min-h-0 px-4 py-3">
            <div className="w-full">
              <TabsContent value="response" className="m-0">
                <BodyRenderer
                  body={capture.response_body}
                  isSse={capture.is_sse}
                  state={capture.state}
                />
              </TabsContent>
              <TabsContent value="request" className="m-0">
                <BodyRenderer body={capture.request_body} isSse={false} />
              </TabsContent>
              <TabsContent value="res-headers" className="m-0">
                <HeadersViewer headers={capture.response_headers} state={capture.state} />
              </TabsContent>
              <TabsContent value="req-headers" className="m-0">
                <HeadersViewer headers={capture.request_headers} />
              </TabsContent>
            </div>
          </ScrollArea>
        </Suspense>
      </Tabs>
    </main>
  );
}
