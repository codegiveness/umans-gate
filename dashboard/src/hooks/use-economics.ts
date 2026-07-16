import { useCallback, useEffect, useRef, useState } from "react";

import { useCaptureDoneListener } from "@/hooks/use-capture-done-listener";
import { apiFetch } from "@/lib/api";
import { API_BASE } from "@/lib/constants";
import type { EconomicsDailyRow, EconomicsSummaryResponse } from "@/types";

const POLL_INTERVAL = 30000;

export interface UseEconomicsResult {
  summary: EconomicsSummaryResponse | null;
  daily: EconomicsDailyRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useEconomics(year: number, month: number): UseEconomicsResult {
  const [summary, setSummary] = useState<EconomicsSummaryResponse | null>(null);
  const [daily, setDaily] = useState<EconomicsDailyRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      try {
        const [summaryRes, dailyRes] = await Promise.all([
          apiFetch(`${API_BASE}/economics/summary?year=${year}&month=${month}`, { signal }),
          apiFetch(`${API_BASE}/economics/daily?limit=90`, { signal }),
        ]);
        if (!summaryRes.ok) throw new Error(`HTTP ${summaryRes.status}`);
        if (!dailyRes.ok) throw new Error(`HTTP ${dailyRes.status}`);
        const summaryData = (await summaryRes.json()) as EconomicsSummaryResponse;
        const dailyData = (await dailyRes.json()) as EconomicsDailyRow[];
        setSummary(summaryData);
        setDaily(dailyData);
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to fetch economics data");
      } finally {
        setLoading(false);
      }
    },
    [year, month],
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

  return { summary, daily, loading, error, refresh };
}
