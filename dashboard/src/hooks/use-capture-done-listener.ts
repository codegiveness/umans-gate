import { useEffect, useRef } from "react";

import { CAPTURE_DONE_EVENT } from "@/lib/constants";

const DEBOUNCE_MS = 500;

/**
 * Listens for the `umans-gate:capture-done` window event (dispatched by
 * useCapturesSocket when a capture finishes) and calls `onDone` after a
 * short debounce. Multiple captures finishing in quick succession collapse
 * into a single `onDone` call.
 */
export function useCaptureDoneListener(onDone: () => void) {
  const fnRef = useRef(onDone);
  fnRef.current = onDone;

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    function handler() {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fnRef.current(), DEBOUNCE_MS);
    }

    window.addEventListener(CAPTURE_DONE_EVENT, handler);
    return () => {
      window.removeEventListener(CAPTURE_DONE_EVENT, handler);
      if (timer) clearTimeout(timer);
    };
  }, []);
}
