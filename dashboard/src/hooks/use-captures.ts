import { useCallback, useEffect, useState } from "react";

import { useCaptureDetail } from "@/hooks/use-capture-detail";
import { useCaptureList } from "@/hooks/use-capture-list";
import { useCapturesSocket } from "@/hooks/use-captures-socket";
import { useGateStats } from "@/hooks/use-gate-stats";
import { API_BASE, CAPTURE_DONE_EVENT } from "@/lib/constants";
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
    onCaptureState: (captureId, state) => {
      setCaptures((prev) => prev.map((c) => (c.id === captureId ? { ...c, state } : c)));
    },
    onGateStats: (stats) => {
      setGateStats(stats);
    },
    onCaptureUpsert: (capture, isNew) => {
      setCaptures((prev) => {
        const next = [...prev];
        const i = next.findIndex((x) => x.id === capture.id);
        if (i >= 0) next[i] = capture;
        else next.unshift(capture);
        next.sort((a, b) => b.id - a.id);
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
  });

  const clearCaptures = useCallback(async () => {
    try {
      await fetch(`${API_BASE}/clear`, { method: "POST" });
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
