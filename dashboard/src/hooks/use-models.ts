import { useCallback, useEffect, useRef, useState } from "react";

import { useCaptureDoneListener } from "@/hooks/use-capture-done-listener";
import { apiFetch } from "@/lib/api";
import { API_BASE } from "@/lib/constants";
import type { ModelsResponse } from "@/types";

const POLL_INTERVAL = 30000;

export interface UseModelsResult {
  data: ModelsResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useModels(): UseModelsResult {
  const [data, setData] = useState<ModelsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Ref mirror of data so the poll callback only errors before the first load
  // (matches usePollingResource: keep last-known-good on transient failures).
  const dataRef = useRef<ModelsResponse | null>(null);
  dataRef.current = data;

  // Shared controller for the polling lifecycle (mount → unmount).
  const pollControllerRef = useRef<AbortController | null>(null);

  const fetchPoll = useCallback(async (signal: AbortSignal) => {
    try {
      const res = await apiFetch(`${API_BASE}/models`, { signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        if (dataRef.current === null) {
          setData(null);
        }
        setError(null);
        return;
      }
      const json = (await res.json()) as ModelsResponse;
      setData(json);
      setError(null);
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      if (dataRef.current === null) {
        setError(err instanceof Error ? err.message : "Failed to fetch models");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  const refresh = useCallback(() => {
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await apiFetch(`${API_BASE}/models/refresh`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) {
          return;
        }
        const json = (await res.json()) as ModelsResponse;
        setData(json);
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to refresh models");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // Capture-done triggers a GET poll (cheap, cached), not a POST refresh
  // (expensive upstream fetch). Matches old usePollingResource behavior.
  const pollRef = useRef(fetchPoll);
  pollRef.current = fetchPoll;
  const pollController = pollControllerRef;
  useCaptureDoneListener(() => {
    if (pollController.current) {
      void pollRef.current(pollController.current.signal);
    }
  });

  useEffect(() => {
    const controller = new AbortController();
    pollControllerRef.current = controller;
    void fetchPoll(controller.signal);

    let interval: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => {
      if (interval === null) {
        interval = setInterval(() => fetchPoll(controller.signal), POLL_INTERVAL);
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
        void fetchPoll(controller.signal);
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
  }, [fetchPoll]);

  return { data, loading, error, refresh };
}
