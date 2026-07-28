/**
 * In-memory tracker for captures currently in TTFT-watchdog cooldown.
 *
 * The DB never persists the `cooling_down` state — the `state` column stays
 * `streaming` during cooldown (see src/types.ts). This tracker bridges the gap
 * so the `/captures` REST endpoint can enrich its response with live cooldown
 * state, surviving dashboard refreshes while a cooldown is in flight.
 *
 * SRP: tracking only. Does not gate, broadcast, or persist.
 */
import type { CaptureState } from "./types.js";

/** Minimal shape enrich needs — satisfied by both CaptureSummary and CaptureRow. */
type Enrichable = { id: number; state: CaptureState };

export interface InFlightCooldown {
  retryAttempt: number;
  cooldownEndsAt: number;
  threshold: number | null;
}

export class InFlightCooldowns {
  private readonly map = new Map<number, InFlightCooldown>();

  start(
    id: number,
    retryAttempt: number,
    cooldownEndsAt: number,
    threshold: number | null = null,
  ): void {
    this.map.set(id, { retryAttempt, cooldownEndsAt, threshold });
  }

  clear(id: number): void {
    this.map.delete(id);
  }

  /**
   * Enrich capture summaries with live cooldown state. A summary whose DB
   * `state` is `streaming` but has an active cooldown entry is rewritten to
   * `cooling_down` with the transient `cooldownEndsAt`, `retryAttempt`, and
   * `threshold` fields populated. Entries whose cooldown has expired are
   * pruned.
   */
  enrich<T extends Enrichable>(summaries: T[]): T[] {
    if (this.map.size === 0) return summaries;
    const now = Date.now();
    let mutated = false;
    const result = summaries.map((s) => {
      const cd = this.map.get(s.id);
      if (!cd) return s;
      if (cd.cooldownEndsAt <= now) {
        this.map.delete(s.id);
        return s;
      }
      if (s.state !== "streaming" && s.state !== "enqueued") return s;
      mutated = true;
      return {
        ...s,
        state: "cooling_down" as const,
        cooldownEndsAt: cd.cooldownEndsAt,
        retryAttempt: cd.retryAttempt,
        threshold: cd.threshold,
      };
    });
    return mutated ? result : summaries;
  }

  /** Snapshot for testing/diagnostics. */
  size(): number {
    return this.map.size;
  }
}
