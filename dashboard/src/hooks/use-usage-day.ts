import { useEffect, useMemo } from "react";

import { usePollingResource } from "@/hooks/use-polling-resource";
import { addDays } from "@/lib/usage-heatmap";
import type { UsageDailyRow, UsageEventRow, UsageSampleRow } from "@/types";

const POLL_INTERVAL = 30000;

/** Parse the samples endpoint response. Unknown shape → null. */
function parseSamples(value: unknown): UsageSampleRow[] | null {
  if (!Array.isArray(value)) return null;
  return value as UsageSampleRow[];
}

/** Parse the events endpoint response. Unknown shape → null. */
function parseEvents(value: unknown): UsageEventRow[] | null {
  if (!Array.isArray(value)) return null;
  return value as UsageEventRow[];
}

/** Parse the daily endpoint response. Unknown shape → null. */
function parseDaily(value: unknown): UsageDailyRow[] | null {
  if (!Array.isArray(value)) return null;
  return value as UsageDailyRow[];
}

export interface UseUsageDayResult {
  samples: UsageSampleRow[] | null;
  events: UsageEventRow[] | null;
  daily30Day: UsageDailyRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/** Fetch samples, events, and 30-day daily aggregates for a single UTC day.
 *  Composes `usePollingResource` (the existing polling abstraction) so we
 *  inherit visibility-aware polling, capture-done refresh, and error handling —
 *  instead of cloning `use-economics.ts` (flagged as code-review debt).
 *
 *  - `/usage/samples?date=YYYY-MM-DD` (ticket 01)
 *  - `/usage/events?date=YYYY-MM-DD`  (ticket 02)
 *  - `/usage/daily?from=<day-30d>&to=<day>` (ticket 03, for the 30-day cache
 *     hit-rate average marker on lane 4) */
export function useUsageDay(dayUtc: string): UseUsageDayResult {
  const samplesEndpoint = `/usage/samples?date=${encodeURIComponent(dayUtc)}`;
  const eventsEndpoint = `/usage/events?date=${encodeURIComponent(dayUtc)}`;
  // 30-day window ending at the selected day (inclusive).
  const dailyFrom = useMemo(() => addDays(dayUtc, -29), [dayUtc]);
  const dailyEndpoint = `/usage/daily?from=${encodeURIComponent(dailyFrom)}&to=${encodeURIComponent(dayUtc)}`;

  const samplesResource = usePollingResource<UsageSampleRow[] | null>({
    endpoint: samplesEndpoint,
    pollInterval: POLL_INTERVAL,
    errorMessage: "Failed to fetch usage samples",
    parse: parseSamples,
  });

  const eventsResource = usePollingResource<UsageEventRow[] | null>({
    endpoint: eventsEndpoint,
    pollInterval: POLL_INTERVAL,
    errorMessage: "Failed to fetch usage events",
    parse: parseEvents,
  });

  const dailyResource = usePollingResource<UsageDailyRow[] | null>({
    endpoint: dailyEndpoint,
    pollInterval: POLL_INTERVAL,
    errorMessage: "Failed to fetch daily usage aggregates",
    parse: parseDaily,
  });

  // usePollingResource reads endpoint from a ref, so its own effect doesn't
  // re-fire on endpoint change. Trigger refresh() explicitly so a new day
  // selection always re-fetches. `refresh` callbacks are stable
  // (useCallback with [] deps in usePollingResource), so each effect below
  // effectively re-runs only when its endpoint changes. Mirrors the pattern
  // in `use-usage-daily.ts`.
  useEffect(() => {
    if (samplesEndpoint) samplesResource.refresh();
  }, [samplesEndpoint, samplesResource.refresh]);

  useEffect(() => {
    if (eventsEndpoint) eventsResource.refresh();
  }, [eventsEndpoint, eventsResource.refresh]);

  useEffect(() => {
    if (dailyEndpoint) dailyResource.refresh();
  }, [dailyEndpoint, dailyResource.refresh]);

  const loading = samplesResource.loading || eventsResource.loading || dailyResource.loading;
  const error = samplesResource.error ?? eventsResource.error ?? dailyResource.error;

  const refresh = () => {
    samplesResource.refresh();
    eventsResource.refresh();
    dailyResource.refresh();
  };

  return {
    samples: samplesResource.data,
    events: eventsResource.data,
    daily30Day: dailyResource.data,
    loading,
    error,
    refresh,
  };
}
