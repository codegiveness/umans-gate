import { useCallback, useEffect, useRef, useState } from "react";

import { useCaptureDoneListener } from "@/hooks/use-capture-done-listener";
import { apiFetch } from "@/lib/api";
import { API_BASE } from "@/lib/constants";
import type { UsageSampleRow } from "@/types";

const POLL_INTERVAL = 30000;

export interface UseUsageHistoryResult {
  samples: UsageSampleRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useUsageHistory(date = "today"): UseUsageHistoryResult {
  const [samples, setSamples] = useState<UsageSampleRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      try {
        const res = await apiFetch(`${API_BASE}/usage/samples?date=${date}`, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as UsageSampleRow[];
        setSamples(data);
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to fetch usage samples");
      } finally {
        setLoading(false);
      }
    },
    [date],
  );

  const refresh = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useCaptureDoneListener(() => refreshRef.current());

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

  return { samples, loading, error, refresh };
}
