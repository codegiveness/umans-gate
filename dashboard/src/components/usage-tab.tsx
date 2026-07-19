import { AlertCircle, Inbox, RefreshCw } from "lucide-react";

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
import { useUsageHistory } from "@/hooks/use-usage-history";
import type { UsageSampleRow } from "@/types";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function UsageTab() {
  const { samples, loading, error, refresh } = useUsageHistory("today");

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Usage</h2>
          {samples && samples.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {samples.length} sample{samples.length === 1 ? "" : "s"} today
            </span>
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
          <TooltipContent side="bottom">Reload usage samples</TooltipContent>
        </Tooltip>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col p-4">
          {loading && !samples ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader className="h-auto" />
            </div>
          ) : samples === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <Inbox className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm font-medium">
                {error ? "Something went wrong" : "No usage samples yet"}
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
            <Card>
              <CardContent className="py-8 text-center text-xs text-muted-foreground">
                No usage samples recorded yet. Wait for the next /v1/usage poll.
              </CardContent>
            </Card>
          ) : (
            <div className="space-y-4">
              {error && (
                <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  <span className="font-medium">Failed to refresh:</span>
                  <span className="text-muted-foreground">{error}</span>
                </div>
              )}
              <SamplesTable samples={samples} />
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

function SamplesTable({ samples }: { samples: UsageSampleRow[] }) {
  return (
    <Card>
      <CardContent className="px-4 py-0">
        <h3 className="py-3 text-sm font-semibold">Today&apos;s Samples</h3>
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
      </CardContent>
    </Card>
  );
}
