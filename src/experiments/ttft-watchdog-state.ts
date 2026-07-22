/**
 * State-tracking for the TTFT-watchdog gated-retry experiment.
 * Holds the auto-disable state (consecutive failure count, window timestamp,
 * disabled-until). Reads breaker/gate state from ConcurrencyGate.getStats(snapshot)
 * but does NOT modify the gate or breaker.
 *
 * SRP: state-tracking only. NOT a gating primitive.
 */
import { createLogger } from "../logger.js";

export interface TtftWatchdogConfig {
  failureThreshold: number;
  failureWindowMs: number;
}

export class TtftWatchdogState {
  private disabledUntil = 0;
  private consecutiveFailures = 0;
  private windowStartedAt = 0;
  private readonly getConfig: () => TtftWatchdogConfig;
  private readonly log = createLogger("experiment_ttft_watchdog");

  constructor(getConfig: () => TtftWatchdogConfig) {
    this.getConfig = getConfig;
  }

  isDisabled(): boolean {
    // disabledUntil is Infinity after auto-disable (permanent until manual
    // re-enable via config reload → reset()). It's 0 when never disabled.
    return this.disabledUntil !== 0 && Date.now() < this.disabledUntil;
  }

  shouldArmWatchdog(): boolean {
    return !this.isDisabled();
  }

  recordRetryOutcome(succeeded: boolean): void {
    if (succeeded) {
      // A retry that produced output counts as a win — reset the window.
      this.consecutiveFailures = 0;
      this.windowStartedAt = 0;
      return;
    }
    const now = Date.now();
    const { failureThreshold, failureWindowMs } = this.getConfig();
    // Start a new window on the first failure, or when the prior window is stale.
    if (this.windowStartedAt === 0 || now - this.windowStartedAt > failureWindowMs) {
      this.windowStartedAt = now;
      this.consecutiveFailures = 0;
    }
    this.consecutiveFailures++;
    if (
      this.consecutiveFailures >= failureThreshold &&
      now - this.windowStartedAt <= failureWindowMs
    ) {
      // Permanent disable — only config reload (reset()) re-enables.
      // Spec: "No more watchdog firings or double-sends occur until the
      // user manually re-enables."
      this.disabledUntil = Number.POSITIVE_INFINITY;
      this.log.info("auto-disabled: efficacy below threshold", {
        consecutive_failures: this.consecutiveFailures,
        threshold: failureThreshold,
        window_ms: failureWindowMs,
      });
      // Reset so a future re-enable (via reset()) starts fresh.
      this.consecutiveFailures = 0;
      this.windowStartedAt = 0;
    }
  }

  recordSuccess(): void {
    // Original request succeeded without retry — prior failures don't accumulate.
    this.consecutiveFailures = 0;
    this.windowStartedAt = 0;
  }

  /** Called on config reload — resets auto-disable so the user can re-enable. */
  reset(): void {
    this.disabledUntil = 0;
    this.consecutiveFailures = 0;
    this.windowStartedAt = 0;
  }

  /** Snapshot of auto-disable state for dashboard/WS consumption. */
  getStats(): {
    disabled: boolean;
    consecutiveFailures: number;
    windowStartedAt: number | null;
  } {
    return {
      disabled: this.isDisabled(),
      consecutiveFailures: this.consecutiveFailures,
      windowStartedAt: this.windowStartedAt || null,
    };
  }
}
