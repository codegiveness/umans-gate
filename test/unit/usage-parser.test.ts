// Unit tests: buildSnapshot + failSafeSnapshot parsing logic.
// Verifies service_mode parsing, priority_budget mapping, ISO→epoch
// conversion, enriched fields, and fail-safe defaults.

import { expect, test } from "bun:test";
import { buildSnapshot, failSafeSnapshot } from "../../src/usage/parser.js";

const validRawResponse = {
  user_id: "test-user-123",
  plan: { display_name: "Code Max", slug: "code_max" },
  limits: {
    requests: { limit: 200, hard_cap: 400, burst_pct: 1.0, window_seconds: 18000 },
    concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
  },
  window: {
    started_at: "2026-07-16T04:51:53.756363+00:00",
    resets_at: "2026-07-16T09:51:53.756363+00:00",
    remaining_minutes: 206,
  },
  usage: {
    requests_in_window: 48,
    weighted_in_window: 24.0,
    remaining_requests: 152,
    weighted_remaining_requests: 76,
    concurrent_sessions: 1,
    weighted_concurrent_sessions: 0.5,
    tokens_in: 1200000,
    tokens_out: 340000,
    tokens_cached: 50000,
    priority: { low: false, boxed_until: null, reason: null },
    service_mode: { current: "interactive", resets_at: null },
    priority_budget: [
      {
        category: "frontier",
        label: "Frontier models",
        models: ["umans-coder", "umans-glm-5.2", "umans-kimi-k2.7"],
        used_pct: 11,
        over_budget_today: false,
        mode: "interactive",
        resets_at: null,
      },
      {
        category: "standard",
        label: "Standard models",
        models: ["umans-flash"],
        used_pct: 80,
        over_budget_today: true,
        mode: "batch",
        resets_at: "2026-07-16T12:00:00Z",
      },
    ],
  },
};

test("buildSnapshot parses service_mode correctly", () => {
  const raw = {
    ...validRawResponse,
    usage: {
      ...validRawResponse.usage,
      service_mode: { current: "degraded", resets_at: "2026-07-16T12:00:00Z" },
    },
  };
  const snap = buildSnapshot(raw, true, 8, 4);
  expect(snap.serviceMode.current).toBe("degraded");
  expect(snap.serviceMode.resetsAt).toBe(Date.parse("2026-07-16T12:00:00Z"));
});

test("buildSnapshot defaults service_mode when absent", () => {
  const { service_mode: _, ...usageWithoutServiceMode } = validRawResponse.usage;
  const raw = { ...validRawResponse, usage: usageWithoutServiceMode };
  const snap = buildSnapshot(raw, true, 8, 4);
  expect(snap.serviceMode.current).toBe("normal");
  expect(snap.serviceMode.resetsAt).toBeNull();
});

test("failSafeSnapshot sets service_mode to normal", () => {
  const snap = failSafeSnapshot();
  expect(snap.serviceMode.current).toBe("normal");
  expect(snap.serviceMode.resetsAt).toBeNull();
});

test("buildSnapshot maps priority_budget to priorityBudget", () => {
  const snap = buildSnapshot(validRawResponse, true, 8, 4);
  expect(snap.priorityBudget).toHaveLength(2);
  const [frontier, standard] = snap.priorityBudget;
  expect(frontier.category).toBe("frontier");
  expect(frontier.label).toBe("Frontier models");
  expect(frontier.models).toEqual(["umans-coder", "umans-glm-5.2", "umans-kimi-k2.7"]);
  expect(frontier.usedPct).toBe(11);
  expect(frontier.overBudgetToday).toBe(false);
  expect(frontier.mode).toBe("interactive");
  expect(frontier.resetsAt).toBeNull();
  expect(standard.category).toBe("standard");
  expect(standard.overBudgetToday).toBe(true);
  expect(standard.mode).toBe("batch");
  expect(standard.resetsAt).toBe(Date.parse("2026-07-16T12:00:00Z"));
});

test("buildSnapshot defaults priority_budget to [] when absent", () => {
  const { priority_budget: _, ...usageWithoutBudget } = validRawResponse.usage;
  const raw = { ...validRawResponse, usage: usageWithoutBudget };
  const snap = buildSnapshot(raw, true, 8, 4);
  expect(snap.priorityBudget).toEqual([]);
});

test("failSafeSnapshot returns priorityBudget: []", () => {
  const snap = failSafeSnapshot();
  expect(snap.priorityBudget).toEqual([]);
});

test("buildSnapshot converts ISO date strings to epoch ms", () => {
  const isoBoxed = "2026-07-16T15:05:04.659189+00:00";
  const isoDemoted = "2026-07-16T16:00:00Z";
  const raw = {
    ...validRawResponse,
    usage: {
      ...validRawResponse.usage,
      priority: {
        low: true,
        boxed_until: isoBoxed,
        reason: "rate limit",
        units_demoted: true,
        demoted_until: isoDemoted,
      },
    },
  };
  const snap = buildSnapshot(raw, true, 8, 4);
  expect(snap.boxedUntil).toBe(Date.parse(isoBoxed));
  expect(snap.demotedUntil).toBe(Date.parse(isoDemoted));
});

test("buildSnapshot captures enriched fields", () => {
  const snap = buildSnapshot(validRawResponse, true, 8, 4);
  expect(snap.userId).toBe("test-user-123");
  expect(snap.planSlug).toBe("code_max");
  expect(snap.tokensIn).toBe(1200000);
  expect(snap.tokensOut).toBe(340000);
  expect(snap.tokensCached).toBe(50000);
  expect(snap.weightedRequestsInWindow).toBe(24.0);
  expect(snap.windowRemainingMinutes).toBe(206);
  expect(snap.windowStartedAt).toBe(Date.parse("2026-07-16T04:51:53.756363+00:00"));
  expect(snap.windowResetsAt).toBe(Date.parse("2026-07-16T09:51:53.756363+00:00"));
});
