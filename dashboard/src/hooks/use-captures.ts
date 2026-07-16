import { useCallback, useEffect, useState } from "react";

import { useCaptureDetail } from "@/hooks/use-capture-detail";
import { useCaptureList } from "@/hooks/use-capture-list";
import { useCapturesSocket } from "@/hooks/use-captures-socket";
import { useGateStats } from "@/hooks/use-gate-stats";
import { apiFetch } from "@/lib/api";
import { API_BASE, CAPTURE_DONE_EVENT, MAX_CAPTURES } from "@/lib/constants";
import type { CaptureDetail, CaptureSummary, GateStats } from "@/types";

export interface UseCapturesResult {
  captures: CaptureSummary[];
  selectedCapture: CaptureDetail | null;
  isLoadingDetail: boolean;
  isLoadingList: boolean;
  wsState: "live" | "down" | "unavailable";
  selectedId: number | null;
  gateStats: GateStats | null;
  listError: string | null;
  gateError: string | null;
  detailError: string | null;
  selectCapture: (id: number) => void;
  clearCaptures: () => void;
  retryList: () => void;
  retryGate: () => void;
  retryDetail: () => void;
}

export function useCaptures(): UseCapturesResult {
  const { captures, setCaptures, isLoadingList, listError, backendReachable, loadList, retryList } =
    useCaptureList();

  const {
    selectedCapture,
    selectedId,
    selectedIdRef,
    selectedCaptureRef,
    isLoadingDetail,
    detailError,
    selectCapture,
    fetchCapture,
    retryDetail,
    resetSelection,
  } = useCaptureDetail();

  const { gateStats, setGateStats, gateError, loadGate, retryGate } = useGateStats();

  const [wsState, setWsState] = useState<"live" | "down" | "unavailable">("down");

  // Initial load.
  useEffect(() => {
    void loadList();
    void loadGate();
  }, [loadList, loadGate]);

  useCapturesSocket({
    backendReachable,
    setWsState,
    onConnected: () => {
      void loadList();
      void loadGate();
    },
    onCaptureClear: () => {
      setCaptures([]);
    },
    onVisionClear: () => {
      setCaptures((prev) => prev.filter((c) => !c.is_vision));
    },
    onCaptureState: (captureId, state) => {
      setCaptures((prev) => {
        const i = prev.findIndex((c) => c.id === captureId);
        if (i < 0) return prev;
        const next = prev.slice();
        next[i] = { ...next[i], state };
        return next;
      });
    },
    onGateStats: (stats) => {
      setGateStats(stats);
    },
    onCaptureUpsert: (capture, isNew) => {
      setCaptures((prev) => {
        const i = prev.findIndex((x) => x.id === capture.id);
        if (i >= 0) {
          const next = prev.slice();
          next[i] = capture;
          return next;
        }
        // New capture: prepend (newest id goes to front since ids are monotonic)
        const next = [capture, ...prev];
        if (next.length > MAX_CAPTURES) next.length = MAX_CAPTURES;
        return next;
      });

      if (!isNew && capture.state === "done") {
        window.dispatchEvent(new CustomEvent(CAPTURE_DONE_EVENT));

        if (
          capture.id === selectedIdRef.current &&
          selectedCaptureRef.current?.state === "streaming"
        ) {
          void fetchCapture(capture.id);
        }
      }
    },
    onCapturePrune: (ids) => {
      if (ids.length === 0) return;
      const idSet = new Set(ids);
      setCaptures((prev) => {
        const filtered = prev.filter((c) => !idSet.has(c.id));
        return filtered.length === prev.length ? prev : filtered;
      });
    },
  });

  const clearCaptures = useCallback(async () => {
    try {
      await apiFetch(`${API_BASE}/clear`, { method: "POST" });
      setCaptures([]);
      resetSelection();
    } catch (e) {
      console.error(e);
    }
  }, [setCaptures, resetSelection]);

  return {
    captures,
    selectedCapture,
    isLoadingDetail,
    isLoadingList,
    wsState,
    selectedId,
    gateStats,
    listError,
    gateError,
    detailError,
    selectCapture,
    clearCaptures,
    retryList,
    retryGate,
    retryDetail,
  };
}

export type { UseCaptureDetailResult } from "@/hooks/use-capture-detail";
export type { UseCaptureListResult } from "@/hooks/use-capture-list";
export type { UseGateStatsResult } from "@/hooks/use-gate-stats";
