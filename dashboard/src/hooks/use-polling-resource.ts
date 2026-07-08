import { useCallback, useEffect, useRef, useState } from "react";

import { useCaptureDoneListener } from "@/hooks/use-capture-done-listener";

export interface UsePollingResourceOptions<T> {
  endpoint: string;
  pollInterval: number;
  errorMessage: string;
  parse: (value: unknown) => T;
}

export interface UsePollingResourceResult<T> {
  data: T;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

const API_BASE = "/dashboard/api";

export function usePollingResource<T>({
  endpoint,
  pollInterval,
  errorMessage,
  parse,
}: UsePollingResourceOptions<T>): UsePollingResourceResult<T> {
  const [data, setData] = useState<T>(() => parse(undefined));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(
    async (signal: AbortSignal) => {
      try {
        const res = await fetch(`${API_BASE}${endpoint}`, { signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          setData(parse(undefined));
          setError(null);
          return;
        }
        const json = (await res.json()) as unknown;
        setData(parse(json));
        setError(null);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : errorMessage);
      } finally {
        setLoading(false);
      }
    },
    [endpoint, errorMessage, parse],
  );

  const refresh = useCallback(() => {
    const controller = new AbortController();
    setLoading(true);
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useCaptureDoneListener(() => refreshRef.current());

  useEffect(() => {
    const controller = new AbortController();
    void fetchData(controller.signal);
    const interval = setInterval(() => fetchData(controller.signal), pollInterval);
    return () => {
      controller.abort();
      clearInterval(interval);
    };
  }, [fetchData, pollInterval]);

  return { data, loading, error, refresh };
}
