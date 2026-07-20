// Ticket 04 — Unit tests for TtftWatchdogState auto-disable + reset (re-enable).
//
// These cover the state machine directly: recordRetryOutcome, recordSuccess,
// isDisabled, shouldArmWatchdog, reset. The end-to-end behavior (proxy
// skipping retry after auto-disable) is covered in ttft-watchdog.test.ts.

import { describe, expect, test } from "bun:test";
import { TtftWatchdogState } from "../src/experiments/ttft-watchdog-state.js";

const makeState = (failureThreshold: number, failureWindowMs: number): TtftWatchdogState =>
  new TtftWatchdogState(() => ({ failureThreshold, failureWindowMs }));

describe("TtftWatchdogState — auto-disable", () => {
  test("not disabled initially", () => {
    const s = makeState(2, 60000);
    expect(s.isDisabled()).toBe(false);
    expect(s.shouldArmWatchdog()).toBe(true);
  });

  test("retry-also-failed below threshold does not disable", () => {
    const s = makeState(3, 60000);
    s.recordRetryOutcome(false);
    s.recordRetryOutcome(false);
    expect(s.isDisabled()).toBe(false);
    expect(s.shouldArmWatchdog()).toBe(true);
  });

  test("threshold consecutive retry failures within window auto-disables", () => {
    const s = makeState(2, 60000);
    s.recordRetryOutcome(false);
    expect(s.isDisabled()).toBe(false);
    s.recordRetryOutcome(false);
    expect(s.isDisabled()).toBe(true);
    expect(s.shouldArmWatchdog()).toBe(false);
  });

  test("retry success resets the failure counter", () => {
    const s = makeState(2, 60000);
    s.recordRetryOutcome(false);
    s.recordRetryOutcome(true);
    // Counter reset to 0 — need 2 more failures to disable.
    s.recordRetryOutcome(false);
    expect(s.isDisabled()).toBe(false);
    s.recordRetryOutcome(false);
    expect(s.isDisabled()).toBe(true);
  });

  test("recordSuccess resets the failure counter", () => {
    const s = makeState(2, 60000);
    s.recordRetryOutcome(false);
    s.recordSuccess();
    // Counter reset to 0 — need 2 more failures to disable.
    s.recordRetryOutcome(false);
    expect(s.isDisabled()).toBe(false);
    s.recordRetryOutcome(false);
    expect(s.isDisabled()).toBe(true);
  });

  test("reset() re-enables the feature after auto-disable", () => {
    const s = makeState(2, 60000);
    s.recordRetryOutcome(false);
    s.recordRetryOutcome(false);
    expect(s.isDisabled()).toBe(true);
    s.reset();
    expect(s.isDisabled()).toBe(false);
    expect(s.shouldArmWatchdog()).toBe(true);
    // After reset, the counter starts fresh — one failure does not disable.
    s.recordRetryOutcome(false);
    expect(s.isDisabled()).toBe(false);
  });
});
