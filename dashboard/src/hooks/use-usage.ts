import { usePollingResource } from "@/hooks/use-polling-resource";
import type { UsageSnapshot } from "@/types";

const POLL_INTERVAL = 30000;

export interface UseUsageResult {
  data: UsageSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useUsage(): UseUsageResult {
  const parse = (value: unknown): UsageSnapshot | null =>
    value === undefined || value === null ? null : (value as UsageSnapshot);

  const { data, loading, error, refresh } = usePollingResource<UsageSnapshot | null>({
    endpoint: "/dashboard/api/usage",
    pollInterval: POLL_INTERVAL,
    errorMessage: "Failed to fetch usage",
    parse,
  });

  return { data, loading, error, refresh };
}
