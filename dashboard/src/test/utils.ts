import { act } from "react";

/**
 * Flush post-render effects inside React's act() so that async state updates
 * (e.g. Base UI ScrollArea measurements, lazy Suspense resolutions) do not
 * trigger "not wrapped in act(...)" warnings in tests.
 *
 * Two rounds are needed:
 * 1. Flushes setTimeout(0) effect callbacks (Base UI scrollbar measurement).
 * 2. Flushes Suspense resolutions that landed during round 1.
 */
export async function flushEffects(): Promise<void> {
  for (let i = 0; i < 2; i++) {
    await act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    });
  }
}
