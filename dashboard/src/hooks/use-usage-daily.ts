import { useEffect } from "react";

import { usePollingResource } from "@/hooks/use-polling-resource";
import type { UsageDailyRow } from "@/types";

const POLL_INTERVAL = 60000;

/** Parse the daily-aggregate endpoint response. Unknown shape → null. */
function parseDaily(value: unknown): UsageDailyRow[] | null {
  if (!Array.isArray(value)) return null;
  return value as UsageDailyRow[];
}

export interface UseUsageDailyResult {
  rows: UsageDailyRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Fetch `GET /dashboard/api/usage/daily?from=&to=` for the given UTC date
 *  range (inclusive). Driven through `usePollingResource` (the existing
 *  polling abstraction) so we inherit visibility-aware polling, capture-done
 *  refresh, and error handling — instead of cloning `use-economics.ts`. */
export function useUsageDaily(from: string, to: string): UseUsageDailyResult {
  const endpoint = `/usage/daily?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const { data, loading, error, refresh } = usePollingResource<UsageDailyRow[] | null>({
    endpoint,
    pollInterval: POLL_INTERVAL,
    errorMessage: "Failed to fetch daily usage aggregates",
    parse: parseDaily,
  });

  // Endpoint changed → force a fresh fetch. usePollingResource reads
  // endpoint from a ref, so its own effect doesn't re-fire on endpoint
  // change. We trigger refresh() explicitly here. `refresh` is stable
  // (useCallback with [] deps in usePollingResource), so this effect
  // effectively re-runs only when `endpoint` changes.
  useEffect(() => {
    // Re-fetch when the endpoint (i.e. the date range) changes.
    // `endpoint` is referenced here so the dependency is exhaustive;
    // `refresh` reads the latest endpoint from a ref inside usePollingResource.
    if (endpoint) {
      refresh();
    }
  }, [endpoint, refresh]);

  return { rows: data, loading, error, refresh };
}
