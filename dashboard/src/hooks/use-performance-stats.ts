import { usePollingResource } from "@/hooks/use-polling-resource";
import type { PerformanceStatsRow } from "@/types";

const POLL_INTERVAL = 10000;

export interface UsePerformanceStatsResult {
  stats: PerformanceStatsRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

function dedupeAndSort(rows: PerformanceStatsRow[]): PerformanceStatsRow[] {
  const best = new Map<string, PerformanceStatsRow>();
  for (const row of rows) {
    const key = `${row.model}\0${row.provider}`;
    const prev = best.get(key);
    if (!prev || row.request_count > prev.request_count) {
      best.set(key, row);
    }
  }
  return [...best.values()].sort((a, b) => {
    const byModel = a.model.localeCompare(b.model);
    if (byModel !== 0) return byModel;
    return a.provider.localeCompare(b.provider);
  });
}

export function usePerformanceStats(): UsePerformanceStatsResult {
  const parse = (value: unknown): PerformanceStatsRow[] | null => {
    if (value === undefined) return null;
    if (!Array.isArray(value)) return null;
    return dedupeAndSort(value as PerformanceStatsRow[]);
  };

  const {
    data: stats,
    loading,
    error,
    refresh,
  } = usePollingResource<PerformanceStatsRow[] | null>({
    endpoint: "/performance",
    pollInterval: POLL_INTERVAL,
    errorMessage: "Failed to fetch performance stats",
    parse,
  });

  return { stats, loading, error, refresh };
}
