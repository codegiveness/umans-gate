import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
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
import { apiFetch } from "@/lib/api";
import { API_BASE } from "@/lib/constants";
import { fmtUtcTime } from "@/lib/format";
import type { IncidentRow } from "@/types";

const POLL_INTERVAL = 30000;

export function IncidentsTab() {
  const [incidents, setIncidents] = useState<IncidentRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await apiFetch(`${API_BASE}/incidents?limit=200`, { signal });
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
  }, []);

  const refresh = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    const controller = new AbortController();
    void fetchData(controller.signal);

    const interval = setInterval(() => fetchData(controller.signal), POLL_INTERVAL);
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        void fetchData(controller.signal);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      controller.abort();
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchData]);

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
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <Inbox className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm font-medium">No incidents recorded</p>
              <p className="text-xs">Non-200 captures will appear here.</p>
            </div>
          ) : (
            <IncidentsTable incidents={incidents} />
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

interface IncidentsTableProps {
  incidents: IncidentRow[];
}

function IncidentsTable({ incidents }: IncidentsTableProps) {
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
              <TableCell className="font-mono text-xs">{row.capture_id}</TableCell>
              <TableCell className="text-xs">{row.responsible_party}</TableCell>
              <TableCell className="text-xs">{row.incident_type}</TableCell>
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
