import { useEffect, useRef } from "react";

import {
  USAGE_EVENT_EVENT,
  USAGE_SAMPLE_EVENT,
  type UsageEventWsDetail,
  type UsageSampleWsDetail,
} from "@/lib/constants";

export interface UseUsageWsParams {
  /** Fired when a `usage-sample` WS message arrives. The hook keeps the
   *  latest callback in a ref so it can be inline (re-rendered each render)
   *  without re-subscribing to the window event. */
  onSample: (detail: UsageSampleWsDetail) => void;
  /** Fired when a `usage-event` WS message arrives. */
  onEvent: (detail: UsageEventWsDetail) => void;
}

/**
 * Subscribe to usage-history WS messages relayed as window events by
 * `useCapturesSocket` (ticket 07). Mirrors the `useCaptureDoneListener`
 * pattern: the socket hook owns the WS connection and re-dispatches
 * relevant messages as window events so sibling hooks can react without
 * opening a second connection.
 */
export function useUsageWs({ onSample, onEvent }: UseUsageWsParams): void {
  const onSampleRef = useRef(onSample);
  onSampleRef.current = onSample;
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    function sampleHandler(e: Event) {
      const detail = (e as CustomEvent<UsageSampleWsDetail>).detail;
      if (detail && typeof detail.dayUtc === "string") {
        onSampleRef.current(detail);
      }
    }
    function eventHandler(e: Event) {
      const detail = (e as CustomEvent<UsageEventWsDetail>).detail;
      if (
        detail &&
        typeof detail.dayUtc === "string" &&
        (detail.tupleKind === "priority" || detail.tupleKind === "service_mode")
      ) {
        onEventRef.current(detail);
      }
    }

    window.addEventListener(USAGE_SAMPLE_EVENT, sampleHandler);
    window.addEventListener(USAGE_EVENT_EVENT, eventHandler);
    return () => {
      window.removeEventListener(USAGE_SAMPLE_EVENT, sampleHandler);
      window.removeEventListener(USAGE_EVENT_EVENT, eventHandler);
    };
  }, []);
}
