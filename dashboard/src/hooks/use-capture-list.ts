import { useCallback, useState } from "react";

import { API_BASE } from "@/lib/constants";
import type { CaptureSummary } from "@/types";

/**
 * Manages fetching, sorting, clearing, and live-updating the capture list.
 *
 * Exposes:
 *  - `captures` / `setCaptures` — list state and a setter for socket-driven upserts,
 *    state patches, and clears.
 *  - `isLoadingList` / `listError` — load lifecycle.
 *  - `loadList` / `retryList` — initial and retry fetchers.
 *  - `clearCapturesLocal` — clears the in-memory list (used by the socket clear handler
 *    and by the orchestrator's hard-clear flow).
 *
 * `backendReachable` is lifted out so the orchestrator can drive the socket based on
 * whether the backend is actually serving JSON.
 */
export interface UseCaptureListResult {
  captures: CaptureSummary[];
  setCaptures: React.Dispatch<React.SetStateAction<CaptureSummary[]>>;
  isLoadingList: boolean;
  listError: string | null;
  backendReachable: boolean;
  loadList: () => Promise<void>;
  retryList: () => void;
}

export function useCaptureList(): UseCaptureListResult {
  const [captures, setCaptures] = useState<CaptureSummary[]>([]);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [backendReachable, setBackendReachable] = useState(false);

  const loadList = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/captures?limit=200`);
      if (!r.ok) {
        setListError(`HTTP ${r.status} ${r.statusText}`);
        setBackendReachable(false);
        return;
      }
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        setBackendReachable(false);
        return;
      }
      const list = (await r.json()) as CaptureSummary[];
      list.sort((a, b) => b.id - a.id);
      setCaptures(list);
      setListError(null);
      setBackendReachable(true);
    } catch (e) {
      setListError(String(e));
      setBackendReachable(false);
    } finally {
      setIsLoadingList(false);
    }
  }, []);

  const retryList = useCallback(() => {
    void loadList();
  }, [loadList]);

  return {
    captures,
    setCaptures,
    isLoadingList,
    listError,
    backendReachable,
    loadList,
    retryList,
  };
}
