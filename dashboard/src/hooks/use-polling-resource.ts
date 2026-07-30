import { useCallback, useEffect, useRef, useState } from "react";

import { useCaptureDoneListener } from "@/hooks/use-capture-done-listener";
import { apiFetch } from "@/lib/api";
import { API_BASE } from "@/lib/constants";

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

export function usePollingResource<T>({
  endpoint,
  pollInterval,
  errorMessage,
  parse,
}: UsePollingResourceOptions<T>): UsePollingResourceResult<T> {
  const [data, setData] = useState<T>(() => parse(undefined));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hasDataRef = useRef(false);

  const abortRef = useRef<AbortController | null>(null);

  const latestRef = useRef({ endpoint, errorMessage, parse });
  latestRef.current = { endpoint, errorMessage, parse };

  const fetchData = useCallback(async (signal: AbortSignal) => {
    const {
      endpoint: currentEndpoint,
      errorMessage: currentErrorMessage,
      parse: currentParse,
    } = latestRef.current;
    try {
      const res = await apiFetch(`${API_BASE}${currentEndpoint}`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        if (!hasDataRef.current) {
          setData(currentParse(undefined));
        }
        setError(null);
        return;
      }
      const json = (await res.json()) as unknown;
      const parsed = currentParse(json);
      setData(parsed);
      setError(null);
      hasDataRef.current = parsed !== null && parsed !== undefined;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      // Keep existing data on transient failures; only error before first load.
      if (!hasDataRef.current) {
        setError(err instanceof Error ? err.message : currentErrorMessage);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setLoading(true);
    setError(null);
    void fetchData(controller.signal);
    return () => controller.abort();
  }, [fetchData]);

  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useCaptureDoneListener(() => refreshRef.current());

  useEffect(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    void fetchData(controller.signal);

    let interval: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (interval === null) {
        interval = setInterval(() => {
          const sig = abortRef.current?.signal;
          if (sig && !sig.aborted) void fetchData(sig);
        }, pollInterval);
      }
    };

    const stopPolling = () => {
      if (interval !== null) {
        clearInterval(interval);
        interval = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        const sig = abortRef.current?.signal;
        if (sig && !sig.aborted) void fetchData(sig);
        startPolling();
      }
    };

    startPolling();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      controller.abort();
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [fetchData, pollInterval]);

  return { data, loading, error, refresh };
}
