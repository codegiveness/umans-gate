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
    onCaptureState: (
      captureId,
      state,
      retryAttempt,
      cooldownEndsAt,
      threshold,
      responseStatus,
      statusSource,
    ) => {
      setCaptures((prev) => {
        const i = prev.findIndex((c) => c.id === captureId);
        if (i < 0) return prev;
        const next = prev.slice();
        const updated: CaptureSummary = {
          ...next[i],
          state,
          retryAttempt,
          cooldownEndsAt: state === "cooling_down" ? cooldownEndsAt : undefined,
          threshold: state === "cooling_down" ? threshold : next[i].threshold,
        };
        if (responseStatus !== undefined) {
          updated.response_status = responseStatus;
        }
        if (statusSource !== undefined) {
          updated.status_source = statusSource;
        }
        next[i] = updated;
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
          const merged = { ...next[i], ...capture };
          // Preserve early-patched values when an incoming update message
          // carries null for fields that were already populated by an
          // earlier broadcast. newSummary() hardcodes these to null, and
          // summary(row) reads the DB (which hasn't been written yet for
          // in-flight fields), so without these guards the TTFT first-chunk
          // update and the p50 detached-fetch update would null out values
          // the dashboard already showed — causing flicker.
          if (capture.response_status == null && next[i].response_status != null) {
            merged.response_status = next[i].response_status;
          }
          if (capture.status_source == null && next[i].status_source != null) {
            merged.status_source = next[i].status_source;
          }
          if (capture.model == null && next[i].model != null) {
            merged.model = next[i].model;
          }
          if (capture.upstream_ttft_p50_ms == null && next[i].upstream_ttft_p50_ms != null) {
            merged.upstream_ttft_p50_ms = next[i].upstream_ttft_p50_ms;
          }
          if (capture.upstream_tps_p50 == null && next[i].upstream_tps_p50 != null) {
            merged.upstream_tps_p50 = next[i].upstream_tps_p50;
          }
          next[i] = merged;
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
