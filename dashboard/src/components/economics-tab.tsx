import {
  Activity,
  AlertCircle,
  ArrowDownUp,
  DollarSign,
  Inbox,
  RefreshCw,
  TrendingUp,
} from "lucide-react";
import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useEconomics } from "@/hooks/use-economics";
import { fmtTokensCompact } from "@/lib/format";
import type { EconomicsDailyRow, EconomicsSummaryResponse, ModelPricingRow } from "@/types";

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

function fmtCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

function fmtCostPrecise(n: number): string {
  if (n === 0) return "$0.0000";
  return `$${n.toFixed(4)}`;
}

interface SortKey {
  key: keyof EconomicsDailyRow;
  label: string;
}

const SORT_KEYS: SortKey[] = [
  { key: "date", label: "Date" },
  { key: "model", label: "Model" },
  { key: "requests", label: "Requests" },
];

export function EconomicsTab() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const { summary, daily, loading, error, refresh } = useEconomics(year, month);

  const availableMonths = summary?.months ?? [];
  const availableYears = useMemo(() => {
    const years = new Set(availableMonths.map((m) => m.year));
    years.add(now.getFullYear());
    return [...years].sort((a, b) => b - a);
  }, [availableMonths, now]);

  // Available months for the currently selected year
  const monthsForYear = useMemo(() => {
    const months = availableMonths
      .filter((m) => m.year === year)
      .map((m) => m.month)
      .sort((a, b) => a - b);
    if (!months.includes(now.getMonth() + 1) && year === now.getFullYear()) {
      months.push(now.getMonth() + 1);
    }
    return months;
  }, [availableMonths, year, now]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Economics</h2>
          {summary && (
            <span className="text-xs text-muted-foreground">
              {MONTH_NAMES[summary.summary.month - 1]} {summary.summary.year}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger size="sm" className="w-[90px]">
              <SelectValue placeholder="Year" />
            </SelectTrigger>
            <SelectContent>
              {availableYears.map((y) => (
                <SelectItem key={y} value={String(y)}>
                  {y}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
            <SelectTrigger size="sm" className="w-[120px]">
              <SelectValue placeholder="Month">
                {(value: string) => MONTH_NAMES[Number(value) - 1]}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {(monthsForYear.length > 0
                ? monthsForYear
                : Array.from({ length: 12 }, (_, i) => i + 1)
              ).map((m) => (
                <SelectItem key={m} value={String(m)}>
                  {MONTH_NAMES[m - 1]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            <TooltipContent side="bottom">Reload economics data</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-7xl flex-col p-4">
          {loading && !summary ? (
            <div className="flex flex-1 items-center justify-center">
              <Loader className="h-auto" />
            </div>
          ) : summary === null ? (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
              <Inbox className="h-12 w-12 text-muted-foreground/40" />
              <p className="text-sm font-medium">
                {error ? "Something went wrong" : "No economics data yet"}
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
                    <TooltipContent side="top">Retry loading economics data</TooltipContent>
                  </Tooltip>
                </>
              ) : (
                <p className="text-xs">
                  Send requests through the proxy to accumulate daily usage.
                </p>
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

              <SummaryCard summary={summary} />
              <DailyTable daily={daily} />
              <PricingCard pricing={summary.pricing} />
            </div>
          )}
        </div>
      </ScrollArea>

      <footer className="border-t border-border bg-green-50 dark:bg-green-800 px-4 py-2 text-center">
        <p className="text-xs font-bold text-green-900 dark:text-green-100">
          Built with gratitude for everyone leveraging Umans
        </p>
      </footer>
    </div>
  );
}

function SummaryCard({ summary }: { summary: EconomicsSummaryResponse }) {
  const s = summary.summary;
  return (
    <Card>
      <CardContent className="px-4 py-0">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold">
              {MONTH_NAMES[s.month - 1]} {s.year} Summary
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {s.requests.toLocaleString()} request{s.requests === 1 ? "" : "s"}
            </p>
          </div>
          {s.has_unpriced && (
            <Tooltip>
              <TooltipTrigger render={<span className="shrink-0 inline-flex" />}>
                <Badge variant="outline">est.</Badge>
              </TooltipTrigger>
              <TooltipContent side="left" className="max-w-[240px]">
                Some models lacked pricing at capture time. Costs shown are estimates and may update
                once pricing syncs.
              </TooltipContent>
            </Tooltip>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
          <StatTile
            icon={<TrendingUp className="h-3.5 w-3.5" />}
            label="Input"
            primary={fmtTokensCompact(s.input_tokens)}
            sub={fmtCost(s.cost_input)}
          />
          <StatTile
            icon={<Activity className="h-3.5 w-3.5" />}
            label="Output"
            primary={fmtTokensCompact(s.output_tokens)}
            sub={fmtCost(s.cost_output)}
          />
          <StatTile
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            label="Cache Read"
            primary={fmtTokensCompact(s.cache_read_tokens)}
            sub={fmtCost(s.cost_cache_read)}
          />
          <StatTile
            icon={<DollarSign className="h-3.5 w-3.5" />}
            label="Total Cost"
            primary={fmtCost(s.cost_total)}
            sub={`${s.requests.toLocaleString()} reqs`}
            highlight
          />
        </div>
      </CardContent>
    </Card>
  );
}

function DailyTable({ daily }: { daily: EconomicsDailyRow[] | null }) {
  const [sortKey, setSortKey] = useState<keyof EconomicsDailyRow>("date");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    if (!daily) return [];
    const rows = [...daily];
    rows.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      let cmp: number;
      if (typeof av === "number" && typeof bv === "number") {
        cmp = av - bv;
      } else {
        cmp = String(av ?? "").localeCompare(String(bv ?? ""));
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return rows;
  }, [daily, sortKey, sortDir]);

  const toggleSort = (key: keyof EconomicsDailyRow) => {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir("desc");
    }
  };

  if (!daily || daily.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-xs text-muted-foreground">
          No daily usage records yet.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="px-4 py-0">
        <h3 className="py-3 text-sm font-semibold">Daily Usage</h3>
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="text-left text-muted-foreground hover:bg-transparent">
              {SORT_KEYS.map((col) => (
                <TableHead key={col.key}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleSort(col.key)}
                    className="h-auto px-0 font-medium text-muted-foreground hover:text-foreground"
                  >
                    {col.label}
                    {sortKey === col.key && (
                      <ArrowDownUp
                        className="h-3 w-3"
                        style={{ transform: sortDir === "asc" ? "scaleY(-1)" : undefined }}
                      />
                    )}
                  </Button>
                </TableHead>
              ))}
              <TableHead>Input</TableHead>
              <TableHead>Output</TableHead>
              <TableHead>Cache Read</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((row) => (
              <TableRow key={`${row.date}-${row.model}`}>
                <TableCell className="tabular-nums">{row.date}</TableCell>
                <TableCell className="max-w-[180px] truncate" title={row.model}>
                  {row.model}
                </TableCell>
                <TableCell className="tabular-nums">{row.requests.toLocaleString()}</TableCell>
                <TableCell className="tabular-nums">{fmtTokensCompact(row.input_tokens)}</TableCell>
                <TableCell className="tabular-nums">
                  {fmtTokensCompact(row.output_tokens)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {fmtTokensCompact(row.cache_read_tokens)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtCost(row.cost_total)}
                  {row.pricing_known === 0 && (
                    <Badge variant="outline" size="sm" className="ml-1">
                      est.
                    </Badge>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PricingCard({ pricing }: { pricing: ModelPricingRow[] }) {
  if (pricing.length === 0) return null;
  return (
    <Card>
      <CardContent className="px-4 py-0">
        <h3 className="py-3 text-sm font-semibold">Pricing Reference</h3>
        <Table className="text-xs">
          <TableHeader>
            <TableRow className="text-left text-muted-foreground hover:bg-transparent">
              <TableHead>Model</TableHead>
              <TableHead className="text-right">Input</TableHead>
              <TableHead className="text-right">Output</TableHead>
              <TableHead className="text-right">Cache Read</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {pricing.map((p) => (
              <TableRow key={p.model_id}>
                <TableCell className="max-w-[200px] truncate" title={p.model_id}>
                  {p.model_id}
                  {p.pricing_known === 0 && (
                    <Badge variant="outline" size="sm" className="ml-1">
                      est.
                    </Badge>
                  )}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtCostPrecise(p.input_per_mtoken)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtCostPrecise(p.output_per_mtoken)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {fmtCostPrecise(p.cache_read_per_mtoken)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="pb-3 text-[0.6875rem] text-muted-foreground">
          Prices per million tokens. Cache read is estimated at ~18.6% of input price when not
          provided by the API.
        </p>
      </CardContent>
    </Card>
  );
}

function StatTile({
  icon,
  label,
  primary,
  sub,
  highlight,
}: {
  icon: React.ReactNode;
  label: string;
  primary: string;
  sub?: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 ${highlight ? "border-primary/30 bg-primary/5" : "border-border bg-muted/30"}`}
    >
      <div className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
        {icon}
        {label}
      </div>
      <div className="mt-1 flex items-baseline gap-1.5">
        <span className="text-lg font-semibold tabular-nums leading-tight">{primary}</span>
      </div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">{sub}</div>}
    </div>
  );
}
