import { useEffect, useRef } from "react";

import { getDashboardToken } from "@/lib/api";
import {
  USAGE_EVENT_EVENT,
  USAGE_SAMPLE_EVENT,
  type UsageEventWsDetail,
  type UsageSampleWsDetail,
  VERSION_EVENT,
} from "@/lib/constants";
import type { CaptureState, CaptureSummary, GateStats, WsMessage } from "@/types";

function buildWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const base = `${proto}://${window.location.host}/dashboard/ws`;
  const token = getDashboardToken();
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/** Semantic callbacks for each WS message type the hook handles. */
interface UseCapturesSocketParams {
  backendReachable: boolean;
  setWsState: (state: "live" | "down" | "unavailable") => void;
  /** Called when the socket connects (used to refresh list + gate). */
  onConnected: () => void;
  /** WS `clear` — wipe all captures. */
  onCaptureClear: () => void;
  /** WS `vision-clear` — remove only vision captures from the list. */
  onVisionClear: () => void;
  /** WS `state` — patch a single capture's state. */
  onCaptureState: (
    captureId: number,
    state: CaptureState,
    retryAttempt?: number,
    cooldownEndsAt?: number,
  ) => void;
  /** WS `gate` — replace gate stats. */
  onGateStats: (stats: GateStats) => void;
  /** WS `new` / `update` — upsert a capture; `isNew` distinguishes the two. */
  onCaptureUpsert: (capture: CaptureSummary, isNew: boolean) => void;
  /** WS `prune` — remove captures evicted by the server's ring buffer. */
  onCapturePrune: (ids: number[]) => void;
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
  onVisionClear,
  onCaptureState,
  onGateStats,
  onCaptureUpsert,
  onCapturePrune,
}: UseCapturesSocketParams) {
  // Keep latest callbacks in refs so the effect doesn't re-run on every render.
  const onConnectedRef = useRef(onConnected);
  onConnectedRef.current = onConnected;
  const onCaptureClearRef = useRef(onCaptureClear);
  onCaptureClearRef.current = onCaptureClear;
  const onVisionClearRef = useRef(onVisionClear);
  onVisionClearRef.current = onVisionClear;
  const onCaptureStateRef = useRef(onCaptureState);
  onCaptureStateRef.current = onCaptureState;
  const onGateStatsRef = useRef(onGateStats);
  onGateStatsRef.current = onGateStats;
  const onCaptureUpsertRef = useRef(onCaptureUpsert);
  onCaptureUpsertRef.current = onCaptureUpsert;
  const onCapturePruneRef = useRef(onCapturePrune);
  onCapturePruneRef.current = onCapturePrune;

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
      "vision-clear": () => onVisionClearRef.current(),
      state: (msg) =>
        onCaptureStateRef.current(msg.captureId, msg.state, msg.retryAttempt, msg.cooldownEndsAt),
      gate: (msg) => onGateStatsRef.current(msg.stats),
      new: (msg) => onCaptureUpsertRef.current(msg.capture, true),
      update: (msg) => onCaptureUpsertRef.current(msg.capture, false),
      prune: (msg) => onCapturePruneRef.current(msg.ids),
      "usage-sample": (msg) => {
        const detail: UsageSampleWsDetail = { dayUtc: msg.dayUtc, fetchedAt: msg.fetchedAt };
        window.dispatchEvent(new CustomEvent(USAGE_SAMPLE_EVENT, { detail }));
      },
      "usage-event": (msg) => {
        const detail: UsageEventWsDetail = {
          dayUtc: msg.dayUtc,
          tupleKind: msg.tupleKind,
          transition: msg.transition,
          fetchedAt: msg.fetchedAt,
        };
        window.dispatchEvent(new CustomEvent(USAGE_EVENT_EVENT, { detail }));
      },
      version: (msg) => {
        window.dispatchEvent(new CustomEvent(VERSION_EVENT, { detail: msg.version }));
      },
    };

    function connect() {
      try {
        ws = new WebSocket(buildWsUrl());
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
