import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { apiFetch } from "@/lib/api";
import { badgeClient, badgeProxy, badgeUpstream } from "@/lib/badge-colors";
import { API_BASE } from "@/lib/constants";
import { fmtUtcTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { CaptureSummary, IncidentRow, IncidentType, ResponsibleParty } from "@/types";

const POLL_INTERVAL = 30000;

type SubTab = "all" | "upstream" | "proxy" | "client";
type TimeWindow = "15m" | "1h" | "24h" | "7d" | "all";

const TIME_WINDOWS: ReadonlyArray<{ value: TimeWindow; label: string; ms: number | null }> = [
  { value: "15m", label: "15 min", ms: 15 * 60 * 1000 },
  { value: "1h", label: "1 hour", ms: 60 * 60 * 1000 },
  { value: "24h", label: "24 hours", ms: 24 * 60 * 60 * 1000 },
  { value: "7d", label: "7 days", ms: 7 * 24 * 60 * 60 * 1000 },
  { value: "all", label: "All", ms: null },
];

const INCIDENT_TYPES: ReadonlyArray<{ value: IncidentType; label: string }> = [
  { value: "upstream_error", label: "upstream_error" },
  { value: "ttft_timeout", label: "ttft_timeout" },
  { value: "id_rewrite", label: "id_rewrite" },
  { value: "rate_limited", label: "rate_limited" },
  { value: "gate_rejected", label: "gate_rejected" },
  { value: "client_aborted", label: "client_aborted" },
];

const PARTY_BADGE: Record<ResponsibleParty, { className: string; label: string }> = {
  upstream: { className: badgeUpstream, label: "Upstream" },
  proxy: { className: badgeProxy, label: "Proxy" },
  client: { className: badgeClient, label: "Client" },
};

const EMPTY_STATE_COPY: Record<SubTab, { title: string; body: string }> = {
  all: {
    title: "No upstream errors recorded in this window.",
    body: "Non-200 captures will appear here.",
  },
  upstream: {
    title: "No upstream errors recorded in this window.",
    body: "Non-200 captures will appear here.",
  },
  proxy: {
    title: "No proxy-injected errors in this window.",
    body: "The gate, rate limiter, and TTFT watchdog operated within bounds.",
  },
  client: {
    title: "No client aborts recorded.",
    body: "Pre-stream client disconnects will appear here.",
  },
};

export interface IncidentsTabProps {
  selectCapture: (id: number) => void;
  navigateToCaptures: () => void;
  captures: CaptureSummary[];
}

export function IncidentsTab({ selectCapture, navigateToCaptures, captures }: IncidentsTabProps) {
  const [subTab, setSubTab] = useState<SubTab>("all");
  const [timeWindow, setTimeWindow] = useState<TimeWindow>("24h");
  const [incidentType, setIncidentType] = useState<IncidentType | "all">("all");

  const [incidents, setIncidents] = useState<IncidentRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      try {
        const params = new URLSearchParams({ limit: "200" });
        if (subTab !== "all") params.set("responsible_party", subTab);
        if (timeWindow !== "all") {
          const preset = TIME_WINDOWS.find((w) => w.value === timeWindow);
          if (preset?.ms != null) {
            params.set("since", String(Date.now() - preset.ms));
          }
        }
        if (incidentType !== "all") params.set("incident_type", incidentType);

        const res = await apiFetch(`${API_BASE}/incidents?${params.toString()}`, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as IncidentRow[];
        setIncidents(data);
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load incidents");
      } finally {
        setLoading(false);
      }
    },
    [subTab, timeWindow, incidentType],
  );

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    const controller = new AbortController();
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const fetchDataRef = useRef(fetchData);
  fetchDataRef.current = fetchData;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetchData(controller.signal);

    const interval = setInterval(() => {
      void fetchDataRef.current(controller.signal);
    }, POLL_INTERVAL);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void fetchDataRef.current(controller.signal);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchData]);

  const evictedIds = useMemo(() => {
    const liveIds = new Set(captures.map((c) => c.id));
    const evicted = new Set<number>();
    if (incidents) {
      for (const row of incidents) {
        if (!liveIds.has(row.capture_id)) evicted.add(row.capture_id);
      }
    }
    return evicted;
  }, [captures, incidents]);

  const showLoading = loading && incidents === null;
  const showError = error !== null && incidents === null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Incidents</h2>
          {incidents && incidents.length > 0 && (
            <span className="text-xs text-muted-foreground">{incidents.length}</span>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={refresh} disabled={loading}>
              {loading ? (
                <Spinner className="mr-1.5 size-3.5" />
              ) : (
                <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              )}
              Refresh
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Reload incidents</TooltipContent>
        </Tooltip>
      </header>

      <div className="border-b border-border bg-card px-4 py-2">
        <div className="flex flex-wrap items-center justify-center gap-3">
          <Tabs value={subTab} onValueChange={(v) => setSubTab(v as SubTab)}>
            <TabsList>
              <TabsTrigger value="all">All</TabsTrigger>
              <TabsTrigger value="upstream">Upstream</TabsTrigger>
              <TabsTrigger value="proxy">Proxy</TabsTrigger>
              <TabsTrigger value="client">Client</TabsTrigger>
            </TabsList>
          </Tabs>

          <div className="flex items-center gap-2">
            <Select value={timeWindow} onValueChange={(v) => setTimeWindow(v as TimeWindow)}>
              <SelectTrigger size="sm" className="w-[120px]" aria-label="Window">
                <SelectValue placeholder="Window" />
              </SelectTrigger>
              <SelectContent>
                {TIME_WINDOWS.map((w) => (
                  <SelectItem key={w.value} value={w.value}>
                    {w.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={incidentType}
              onValueChange={(v) => setIncidentType(v as IncidentType | "all")}
            >
              <SelectTrigger size="sm" className="w-[160px]" aria-label="Type">
                <SelectValue placeholder="Type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All types</SelectItem>
                {INCIDENT_TYPES.map((t) => (
                  <SelectItem key={t.value} value={t.value}>
                    {t.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col p-4">
          {showLoading ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader className="h-auto" />
            </div>
          ) : showError ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <AlertCircle className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm font-medium">Failed to load incidents</p>
              {error ? <p className="text-xs">{error}</p> : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline" size="sm" onClick={refresh}>
                    Retry
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Retry loading incidents</TooltipContent>
              </Tooltip>
            </div>
          ) : incidents === null || incidents.length === 0 ? (
            <EmptyState subTab={subTab} />
          ) : (
            <IncidentsTable
              incidents={incidents}
              evictedIds={evictedIds}
              onSelectCapture={(id) => {
                selectCapture(id);
                navigateToCaptures();
              }}
            />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

interface EmptyStateProps {
  subTab: SubTab;
}

function EmptyState({ subTab }: EmptyStateProps) {
  const copy = EMPTY_STATE_COPY[subTab];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
      <Inbox className="h-12 w-12 text-muted-foreground/40" />
      <p className="text-sm font-medium">{copy.title}</p>
      <p className="text-xs">{copy.body}</p>
    </div>
  );
}

interface IncidentsTableProps {
  incidents: IncidentRow[];
  evictedIds: Set<number>;
  onSelectCapture: (id: number) => void;
}

function IncidentsTable({ incidents, evictedIds, onSelectCapture }: IncidentsTableProps) {
  return (
    <div className="rounded-md border border-border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Capture</TableHead>
            <TableHead>Party</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Reason</TableHead>
            <TableHead>Retry</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {incidents.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="whitespace-nowrap tabular-nums text-xs text-muted-foreground">
                {fmtUtcTime(row.created_at)}
              </TableCell>
              <CaptureIdCell
                captureId={row.capture_id}
                evicted={evictedIds.has(row.capture_id)}
                onSelect={onSelectCapture}
              />
              <TableCell>
                <PartyBadge party={row.responsible_party} />
              </TableCell>
              <TableCell className="font-mono text-xs">{row.incident_type}</TableCell>
              <TableCell className="whitespace-nowrap font-mono text-xs">
                {row.upstream_status === null ? "null" : row.upstream_status} → {row.served_status}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{row.reason ?? "—"}</TableCell>
              <TableCell className="text-xs tabular-nums">
                {row.retry_attempt && row.retry_attempt > 0 ? row.retry_attempt : "—"}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

interface CaptureIdCellProps {
  captureId: number;
  evicted: boolean;
  onSelect: (id: number) => void;
}

function CaptureIdCell({ captureId, evicted, onSelect }: CaptureIdCellProps) {
  if (evicted) {
    return (
      <TableCell className="font-mono text-xs text-muted-foreground/60">
        {captureId} <span className="text-muted-foreground/50">(evicted)</span>
      </TableCell>
    );
  }
  return (
    <TableCell className="font-mono text-xs">
      <button
        type="button"
        className="text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
        onClick={() => onSelect(captureId)}
      >
        {captureId}
      </button>
    </TableCell>
  );
}

interface PartyBadgeProps {
  party: ResponsibleParty;
}

function PartyBadge({ party }: PartyBadgeProps) {
  const cfg = PARTY_BADGE[party];
  return (
    <Badge variant="secondary" size="sm" className={cn(cfg.className)}>
      {cfg.label}
    </Badge>
  );
}
