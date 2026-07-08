import { usePollingResource } from "@/hooks/use-polling-resource";
import type { PerformanceStatsRow } from "@/types";

const POLL_INTERVAL = 10000;

export interface UsePerformanceStatsResult {
  stats: PerformanceStatsRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function usePerformanceStats(): UsePerformanceStatsResult {
  const parse = (value: unknown): PerformanceStatsRow[] | null =>
    value === undefined ? null : (value as PerformanceStatsRow[]);

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
