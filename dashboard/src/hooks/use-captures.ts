import { useCallback, useEffect, useRef, useState } from "react";

import { useCapturesSocket } from "@/hooks/use-captures-socket";
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
  const [captures, setCaptures] = useState<CaptureSummary[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedCapture, setSelectedCapture] = useState<CaptureDetail | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [wsState, setWsState] = useState<"live" | "down" | "unavailable">("down");
  const [gateStats, setGateStats] = useState<GateStats | null>(null);
  const [isLoadingList, setIsLoadingList] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [backendReachable, setBackendReachable] = useState(false);

  const selectedCaptureRef = useRef(selectedCapture);
  selectedCaptureRef.current = selectedCapture;

  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const fetchCapture = useCallback(async (id: number) => {
    setIsLoadingDetail(true);
    try {
      const r = await fetch(`${API_BASE}/captures/${id}`);
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

  const loadGate = useCallback(async () => {
    try {
      const r = await fetch(`${API_BASE}/gate`);
      if (!r.ok) {
        setGateError(`HTTP ${r.status} ${r.statusText}`);
        return;
      }
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        return;
      }
      setGateStats((await r.json()) as GateStats);
      setGateError(null);
    } catch (e) {
      setGateError(String(e));
    }
  }, []);

  // Initial load.
  useEffect(() => {
    void loadList();
    void loadGate();
  }, [loadList, loadGate]);

  const reloadList = loadList;
  const reloadGate = loadGate;

  const retryList = useCallback(() => {
    void loadList();
  }, [loadList]);

  const retryGate = useCallback(() => {
    void loadGate();
  }, [loadGate]);

  const retryDetail = useCallback(() => {
    const id = selectedIdRef.current;
    if (id !== null) {
      void fetchCapture(id);
    }
  }, [fetchCapture]);

  useCapturesSocket({
    backendReachable,
    setWsState,
    onConnected: () => {
      void reloadList();
      void reloadGate();
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
      setSelectedId(null);
      setSelectedCapture(null);
    } catch (e) {
      console.error(e);
    }
  }, []);

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
