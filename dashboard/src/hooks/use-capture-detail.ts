import { useCallback, useRef, useState } from "react";

import { apiFetch } from "@/lib/api";
import { API_BASE } from "@/lib/constants";
import type { CaptureDetail } from "@/types";

/**
 * Manages fetching and retrying the selected capture detail.
 *
 * `selectedIdRef` is a stable ref the orchestrator uses to detect whether a
 * completed-stream capture is the currently-selected one (for auto-refresh),
 * without forcing `fetchCapture` to depend on `selectedId`.
 */
export interface UseCaptureDetailResult {
  selectedCapture: CaptureDetail | null;
  setSelectedCapture: React.Dispatch<React.SetStateAction<CaptureDetail | null>>;
  selectedId: number | null;
  selectedIdRef: React.RefObject<number | null>;
  selectedCaptureRef: React.RefObject<CaptureDetail | null>;
  isLoadingDetail: boolean;
  detailError: string | null;
  selectCapture: (id: number) => void;
  fetchCapture: (id: number) => Promise<void>;
  retryDetail: () => void;
  resetSelection: () => void;
}

export function useCaptureDetail(): UseCaptureDetailResult {
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedCapture, setSelectedCapture] = useState<CaptureDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const selectedCaptureRef = useRef(selectedCapture);
  selectedCaptureRef.current = selectedCapture;

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const fetchCapture = useCallback(async (id: number) => {
    setIsLoadingDetail(true);
    try {
      const r = await apiFetch(`${API_BASE}/captures/${id}`);
      if (!r.ok) {
        setDetailError(`HTTP ${r.status} ${r.statusText}`);
        return;
      }
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        setDetailError("Backend not reachable");
        return;
      }
      const c = (await r.json()) as CaptureDetail;
      setSelectedCapture(c);
      setDetailError(null);
    } catch (e) {
      setDetailError(String(e));
    } finally {
      setIsLoadingDetail(false);
    }
  }, []);

  const selectCapture = useCallback(
    (id: number) => {
      setSelectedId(id);
      setSelectedCapture(null);
      setDetailError(null);
      void fetchCapture(id);
    },
    [fetchCapture],
  );

  const retryDetail = useCallback(() => {
    const id = selectedIdRef.current;
    if (id !== null) {
      void fetchCapture(id);
    }
  }, [fetchCapture]);

  const resetSelection = useCallback(() => {
    setSelectedId(null);
    setSelectedCapture(null);
  }, []);

  return {
    selectedCapture,
    setSelectedCapture,
    selectedId,
    selectedIdRef,
    selectedCaptureRef,
    isLoadingDetail,
    detailError,
    selectCapture,
    fetchCapture,
    retryDetail,
    resetSelection,
  };
}
