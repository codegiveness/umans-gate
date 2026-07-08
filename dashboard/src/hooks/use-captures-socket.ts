import { useEffect, useRef } from "react";

import type { CaptureState, CaptureSummary, GateStats, WsMessage } from "@/types";

const WS_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/dashboard/ws`;

/** Semantic callbacks for each WS message type the hook handles. */
interface UseCapturesSocketParams {
  backendReachable: boolean;
  setWsState: (state: "live" | "down" | "unavailable") => void;
  /** Called when the socket connects (used to refresh list + gate). */
  onConnected: () => void;
  /** WS `clear` — wipe all captures. */
  onCaptureClear: () => void;
  /** WS `state` — patch a single capture's state. */
  onCaptureState: (captureId: number, state: CaptureState) => void;
  /** WS `gate` — replace gate stats. */
  onGateStats: (stats: GateStats) => void;
  /** WS `new` / `update` — upsert a capture; `isNew` distinguishes the two. */
  onCaptureUpsert: (capture: CaptureSummary, isNew: boolean) => void;
}

/**
 * Maps each WS message type to its handler. Adding a new message type
 * requires only one entry here.
 */
type WsHandlerMap = {
  [K in WsMessage["type"]]: (msg: Extract<WsMessage, { type: K }>) => void;
};

/**
 * WebSocket connection with auto-reconnect.
 * Only attempts when the backend is reachable, to avoid console errors
 * when the dashboard is served statically without the proxy backend.
 */
export function useCapturesSocket({
  backendReachable,
  setWsState,
  onConnected,
  onCaptureClear,
  onCaptureState,
  onGateStats,
  onCaptureUpsert,
}: UseCapturesSocketParams) {
  // Keep latest callbacks in refs so the effect doesn't re-run on every render.
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const onCaptureClearRef = useRef(onCaptureClear);
  onCaptureClearRef.current = onCaptureClear;
  const onCaptureStateRef = useRef(onCaptureState);
  onCaptureStateRef.current = onCaptureState;
  const onGateStatsRef = useRef(onGateStats);
  onGateStatsRef.current = onGateStats;
  const onCaptureUpsertRef = useRef(onCaptureUpsert);
  onCaptureUpsertRef.current = onCaptureUpsert;

  useEffect(() => {
    if (!backendReachable) {
      setWsState("unavailable");
      return;
    }

    let ws: WebSocket | null = null;
    let cancelled = false;

    // Dispatch registry: one entry per WS message type.
    const handlers: WsHandlerMap = {
      clear: () => onCaptureClearRef.current(),
      state: (msg) => onCaptureStateRef.current(msg.captureId, msg.state),
      gate: (msg) => onGateStatsRef.current(msg.stats),
      new: (msg) => onCaptureUpsertRef.current(msg.capture, true),
      update: (msg) => onCaptureUpsertRef.current(msg.capture, false),
    };

    function connect() {
      try {
        ws = new WebSocket(WS_URL);
      } catch {
        setWsState("unavailable");
        return;
      }

      ws.onopen = () => {
        setWsState("live");
        void onConnectedRef.current();
      };

      ws.onmessage = (event: MessageEvent<string>) => {
        try {
          const msg = JSON.parse(event.data) as WsMessage;
          // TypeScript can't prove handlers[msg.type] accepts `msg` (a known
          // limitation of discriminated-union indexed access). The cast is
          // safe: WsHandlerMap guarantees each handler matches its variant.
          const handler = handlers[msg.type] as (m: WsMessage) => void;
          handler(msg);
        } catch (e) {
          console.error(e);
        }
      };

      ws.onclose = () => {
        setWsState("down");
        if (!cancelled) {
          setTimeout(connect, 1000);
        }
      };

      ws.onerror = () => {
        ws?.close();
      };
    }

    connect();

    return () => {
      cancelled = true;
      ws?.close();
    };
  }, [backendReachable, setWsState]);
}
