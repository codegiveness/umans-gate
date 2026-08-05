import { expect, test } from "bun:test";
import {
  computeRequestGateDecision,
  type RequestGateDecision,
  type RequestGateStats,
} from "../../src/request-gate.js";

const MARGIN = 50;

const fixtures = {
  hard1000Limit500: {
    requestsInWindow: 950,
    requestsHardCap: 1000,
    requestsLimit: 500,
  } satisfies RequestGateStats,
};

test("hardCap 1000, limit 500, margin 50, useHardCap true: at threshold => block", () => {
  const decision = computeRequestGateDecision(fixtures.hard1000Limit500, MARGIN, true);
  expect(decision.block).toBe(true);
  expect(decision.cap).toBe(1000);
  expect(decision.threshold).toBe(950);
});

test("hardCap 1000, limit 500, margin 50, useHardCap true: below threshold => no block", () => {
  const decision = computeRequestGateDecision(
    { ...fixtures.hard1000Limit500, requestsInWindow: 949 },
    MARGIN,
    true,
  );
  expect(decision.block).toBe(false);
  expect(decision.cap).toBe(1000);
  expect(decision.threshold).toBe(950);
});

test("useHardCap false falls back to limit: cap 500, threshold 450", () => {
  const decision = computeRequestGateDecision(
    { ...fixtures.hard1000Limit500, requestsInWindow: 950 },
    MARGIN,
    false,
  );
  expect(decision.block).toBe(true);
  expect(decision.cap).toBe(500);
  expect(decision.threshold).toBe(450);
});

test("hardCap null falls back to limit when useHardCap true", () => {
  const decision = computeRequestGateDecision(
    {
      requestsInWindow: 950,
      requestsHardCap: null,
      requestsLimit: 1000,
    },
    MARGIN,
    true,
  );
  expect(decision.block).toBe(true);
  expect(decision.cap).toBe(1000);
  expect(decision.threshold).toBe(950);
});

test("both caps null => no block, cap null, threshold null", () => {
  const decision = computeRequestGateDecision(
    {
      requestsInWindow: 950,
      requestsHardCap: null,
      requestsLimit: null,
    },
    MARGIN,
    true,
  );
  expect(decision.block).toBe(false);
  expect(decision.cap).toBeNull();
  expect(decision.threshold).toBeNull();
});

test("margin 0 => threshold equals cap", () => {
  const decision = computeRequestGateDecision(fixtures.hard1000Limit500, 0, true);
  expect(decision.threshold).toBe(1000);
  expect(decision.threshold).toBe(decision.cap);
});

test("negative margin clamped to 0 => threshold equals cap", () => {
  const decision = computeRequestGateDecision(fixtures.hard1000Limit500, -10, true);
  expect(decision.threshold).toBe(1000);
  expect(decision.threshold).toBe(decision.cap);
});

test("float margin 49.7 floors to 49 => threshold cap-49", () => {
  const decision = computeRequestGateDecision(
    {
      requestsInWindow: 951,
      requestsHardCap: 1000,
      requestsLimit: 500,
    },
    49.7,
    true,
  );
  expect(decision.threshold).toBe(951);
  expect(decision.cap).toBe(1000);
});

test("boundary: requestsInWindow exactly equals cap with margin 50 => block", () => {
  const decision = computeRequestGateDecision(
    { ...fixtures.hard1000Limit500, requestsInWindow: 1000 },
    MARGIN,
    true,
  );
  expect(decision.block).toBe(true);
  expect(decision.cap).toBe(1000);
  expect(decision.threshold).toBe(950);
});

test("types are exported and usable", () => {
  const stats: RequestGateStats = {
    requestsInWindow: 950,
    requestsHardCap: 1000,
    requestsLimit: 500,
  };

  const decision: RequestGateDecision = computeRequestGateDecision(stats, MARGIN, true);

  // Type-level: cap/threshold are number | null, block boolean
  expect(decision.block).toBeTypeOf("boolean");
  if (decision.cap !== null) {
    expect(decision.cap).toBeTypeOf("number");
  }
  if (decision.threshold !== null) {
    expect(decision.threshold).toBeTypeOf("number");
  }
});

test("margin >= cap falls back to zero buffer: threshold equals cap (won't reject below cap)", () => {
  const decision = computeRequestGateDecision(
    { requestsInWindow: 0, requestsHardCap: 500, requestsLimit: 500 },
    500,
    true,
  );
  expect(decision.threshold).toBe(500);
  expect(decision.cap).toBe(500);
  expect(decision.block).toBe(false);
});

test("margin just below cap still blocks once window crosses low threshold", () => {
  const decision = computeRequestGateDecision(
    { requestsInWindow: 1, requestsHardCap: 500, requestsLimit: 500 },
    499,
    true,
  );
  expect(decision.threshold).toBe(1);
  expect(decision.block).toBe(true);
});
