import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, Inbox, RotateCcw, Trash2 } from "lucide-react";
import { Suspense, lazy, useRef, useState } from "react";

import { CaptureRowItem } from "@/components/capture-row-item";
import { GateStatus } from "@/components/gate-status";
import { useMasterDetail } from "@/components/layout/master-detail-layout";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useCaptureListbox } from "@/hooks/use-capture-listbox";
import { cn } from "@/lib/utils";
import type { CaptureSummary, GateStats } from "@/types";
import { WsStatusBadge } from "./ws-status-badge";

const ClearConfirmDialog = lazy(() =>
  import("@/components/clear-confirm-dialog").then((m) => ({
    default: m.ClearConfirmDialog,
  })),
);

interface CaptureListProps {
  captures: CaptureSummary[];
  selectedId: number | null;
  wsState: "live" | "down" | "unavailable";
  gateStats: GateStats | null;
  listError: string | null;
  isLoading: boolean;
  onSelect: (id: number) => void;
  onClear: () => void;
  onRetry: () => void;
}

/**
 * Fixed row height for the virtualizer. Must be >= actual rendered row
 * height to prevent overlap. Calculated from: py-3 (24) + 3 content rows
 * (~65) + border (1) = ~90px; 2px buffer for font/badge variance.
 */
const ROW_HEIGHT = 92;

export function CaptureList({
  captures,
  selectedId,
  wsState,
  gateStats,
  listError,
  isLoading,
  onSelect,
  onClear,
  onRetry,
}: CaptureListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const { closeDrawer, isOpen } = useMasterDetail();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const virtualizer = useVirtualizer({
    count: captures.length,
    getScrollElement: () => viewportRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const totalHeight = virtualizer.getTotalSize();
  const items = virtualizer.getVirtualItems();

  const handleSelect = (id: number) => {
    onSelect(id);
    closeDrawer();
  };

  const { activeIndex, activeOptionId, handleKeyDown, handleRowClick } = useCaptureListbox({
    captures,
    selectedId,
    onSelectId: handleSelect,
    scrollToIndex: virtualizer.scrollToIndex,
  });

  return (
    <aside className="flex h-full w-full min-w-0 flex-col border-r border-border bg-card">
      <header
        className={cn(
          "flex items-center justify-between border-b border-border bg-card px-4 py-3",
          isOpen && "pr-12",
        )}
      >
        <h2 className="text-sm font-semibold">
          Captures <span className="text-muted-foreground">({captures.length})</span>
        </h2>
        <div className="flex items-center gap-2">
          <WsStatusBadge wsState={wsState} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
                <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                Clear
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Remove all recorded captures</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <GateStatus stats={gateStats} />

      {wsState !== "live" && captures.length > 0 && (
        <output
          aria-live="polite"
          className="flex items-center gap-1.5 border-b px-4 py-2 text-xs text-muted-foreground"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-muted-foreground" aria-hidden />
          List may be stale — {wsState === "down" ? "reconnecting" : "disconnected"}
        </output>
      )}

      {captures.length === 0 ? (
        listError ? (
          <section
            aria-label="Captures"
            className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground"
          >
            <AlertCircle className="h-12 w-12 text-destructive" />
            <p className="text-sm font-medium text-destructive">Something went wrong</p>
            <p className="text-xs">{listError}</p>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="outline" size="sm" onClick={onRetry}>
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Retry
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Retry loading captures</TooltipContent>
            </Tooltip>
          </section>
        ) : isLoading ? (
          <section
            aria-label="Captures"
            className="flex flex-1 flex-col items-center justify-center overflow-hidden"
          >
            <Loader className="h-auto" />
          </section>
        ) : (
          <section
            aria-label="Captures"
            className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground"
          >
            <Inbox className="h-12 w-12 text-muted-foreground/40" />
            <p className="text-sm font-medium">No captures yet</p>
            <p className="text-xs">Send a request through the proxy to see it here.</p>
          </section>
        )
      ) : (
        <ScrollArea
          className="min-h-0 flex-1 overflow-hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          viewportRef={viewportRef}
          // biome-ignore lint/a11y/useSemanticElements: virtualized listbox needs role on scroll container
          role="listbox"
          aria-label="Captures"
          aria-activedescendant={activeOptionId}
          tabIndex={0}
          onKeyDown={handleKeyDown}
        >
          <div
            className={cn("relative", wsState !== "live" && captures.length > 0 && "opacity-60")}
            style={{ height: totalHeight }}
          >
            {items.map((virtualRow) => {
              const c = captures[virtualRow.index];
              if (!c) return null;
              return (
                <div
                  key={c.id}
                  data-index={virtualRow.index}
                  style={{
                    position: "absolute",
                    top: 0,
                    left: 0,
                    width: "100%",
                    height: virtualRow.size,
                    transform: `translateY(${virtualRow.start}px)`,
                  }}
                >
                  <CaptureRowItem
                    capture={c}
                    selected={c.id === selectedId}
                    isActive={virtualRow.index === activeIndex}
                    optionId={`capture-opt-${c.id}`}
                    onActivate={() => handleRowClick(virtualRow.index)}
                  />
                </div>
              );
            })}
          </div>
        </ScrollArea>
      )}

      {confirmOpen && (
        <Suspense fallback={null}>
          <ClearConfirmDialog
            open={confirmOpen}
            count={captures.length}
            onConfirm={() => {
              setConfirmOpen(false);
              onClear();
            }}
            onClose={() => setConfirmOpen(false)}
          />
        </Suspense>
      )}
    </aside>
  );
}
