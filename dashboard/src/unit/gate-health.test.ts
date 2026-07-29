import { describe, expect, it } from "vitest";

import {
  computeGateHealth,
  type GateHealthBudget,
  type GateHealthInput,
  mergePenaltyInput,
} from "@/lib/gate-health";
import type { GateStats, UsageSnapshot } from "@/types";

const RED_CLASS = "text-destructive";
const AMBER_CLASS = "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
const BLUE_CLASS = "bg-blue-500/10 text-blue-600 dark:text-blue-400";
const GREEN_CLASS =
  "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

function budget(overrides: Partial<GateHealthBudget> = {}): GateHealthBudget {
  return {
    category: "frontier",
    label: "Frontier models",
    usedPct: 49,
    overBudgetToday: false,
    mode: "interactive",
    models: ["umans-glm-5.2"],
    resetsAt: null,
    ...overrides,
  };
}

function input(overrides: Partial<GateHealthInput> = {}): GateHealthInput {
  return {
    admissionLabel: "high",
    budgets: [],
    admissionDetail: undefined,
    boxed: false,
    boxedReason: null,
    boxedUntil: null,
    unitsDemoted: false,
    demotedUntil: null,
    serviceMode: null,
    ...overrides,
  };
}

describe("computeGateHealth — green / healthy", () => {
  it("returns 'healthy' label and green tier when no penalties", () => {
    const result = computeGateHealth(input());
    expect(result.label).toBe("healthy");
    expect(result.tier).toBe("green");
    expect(result.className).toBe(GREEN_CLASS);
    expect(result.variant).toBe("secondary");
    expect(result.offendingCategories).toEqual([]);
  });

  it("returns green tier when budgets healthy and admission high", () => {
    const result = computeGateHealth(
      input({
        budgets: [budget({ usedPct: 30, overBudgetToday: false, mode: "interactive" })],
      }),
    );
    expect(result.tier).toBe("green");
    expect(result.offendingCategories).toEqual([]);
  });
});

describe("computeGateHealth — red tier", () => {
  it("red when boxed true", () => {
    const result = computeGateHealth(
      input({
        admissionLabel: "boxed",
        boxed: true,
      }),
    );
    expect(result.tier).toBe("red");
    expect(result.label).toBe("boxed");
    expect(result.className).toBe(RED_CLASS);
  });

  it("red boxed label includes 'resets' countdown when boxedUntil set", () => {
    const result = computeGateHealth(
      input({
        admissionLabel: "boxed",
        boxed: true,
        boxedUntil: Date.now() + 8100000,
      }),
    );
    expect(result.label.startsWith("boxed · resets")).toBe(true);
  });

  it("red boxed label omits '· resets' when boxedUntil null", () => {
    const result = computeGateHealth(
      input({
        admissionLabel: "boxed",
        boxed: true,
        boxedUntil: null,
      }),
    );
    expect(result.label).toBe("boxed");
  });

  it("red when unitsDemoted true", () => {
    const result = computeGateHealth(
      input({
        admissionLabel: "demoted",
        unitsDemoted: true,
        demotedUntil: Date.now() + 18000000,
      }),
    );
    expect(result.tier).toBe("red");
    expect(result.label.startsWith("demoted · resets")).toBe(true);
  });

  it("red demoted label omits '· resets' when demotedUntil null", () => {
    const result = computeGateHealth(
      input({
        admissionLabel: "demoted",
        unitsDemoted: true,
        demotedUntil: null,
      }),
    );
    expect(result.label).toBe("demoted");
  });

  it("red when any budget overBudgetToday true", () => {
    const result = computeGateHealth(
      input({
        budgets: [
          budget({ usedPct: 50, overBudgetToday: true }),
          budget({ category: "kimi", label: "Kimi", usedPct: 30 }),
        ],
      }),
    );
    expect(result.tier).toBe("red");
    expect(result.offendingCategories).toHaveLength(1);
    expect(result.offendingCategories[0].label).toBe("Frontier models");
  });
});

describe("computeGateHealth — amber tier", () => {
  it("amber when priorityLow without boxing", () => {
    const result = computeGateHealth(input({ admissionLabel: "low" }));
    expect(result.tier).toBe("amber");
    expect(result.className).toBe(AMBER_CLASS);
  });

  it("amber when serviceMode is a low mode", () => {
    const result = computeGateHealth(
      input({
        serviceMode: { current: "low_interactivity", resetsAt: null },
      }),
    );
    expect(result.tier).toBe("amber");
  });

  it("amber when any budget mode !== 'interactive'", () => {
    const result = computeGateHealth(
      input({
        budgets: [
          budget({ usedPct: 30, mode: "standard" }),
          budget({ category: "kimi", label: "Kimi", usedPct: 10 }),
        ],
      }),
    );
    expect(result.tier).toBe("amber");
    expect(result.offendingCategories).toHaveLength(1);
    expect(result.offendingCategories[0].label).toBe("Frontier models");
    expect(result.offendingCategories[0].mode).toBe("standard");
  });

  it("amber when any budget usedPct >= 80", () => {
    const result = computeGateHealth(
      input({
        budgets: [
          budget({ usedPct: 87 }),
          budget({ category: "kimi", label: "Kimi", usedPct: 50 }),
        ],
      }),
    );
    expect(result.tier).toBe("amber");
    expect(result.offendingCategories).toHaveLength(1);
    expect(result.offendingCategories[0].label).toBe("Frontier models");
    expect(result.offendingCategories[0].usedPct).toBe(87);
  });

  it("amber when two budgets over 80% — worst both shown", () => {
    const result = computeGateHealth(
      input({
        budgets: [
          budget({ usedPct: 95 }),
          budget({ category: "kimi", label: "Kimi", usedPct: 88 }),
        ],
      }),
    );
    expect(result.tier).toBe("amber");
    expect(result.offendingCategories).toHaveLength(2);
  });

  it("amber label shows comma-joined worst 2 budgets", () => {
    const result = computeGateHealth(
      input({
        budgets: [
          budget({ usedPct: 95 }),
          budget({ category: "kimi", label: "Kimi", usedPct: 88 }),
        ],
      }),
    );
    expect(result.label).toBe("Frontier models 95%, Kimi 88%");
  });

  it("amber label appends '+N' when more than 2 offending", () => {
    const result = computeGateHealth(
      input({
        budgets: [
          budget({ usedPct: 95 }),
          budget({ category: "kimi", label: "Kimi", usedPct: 90 }),
          budget({ category: "glm", label: "GLM", usedPct: 85 }),
        ],
      }),
    );
    expect(result.label).toBe("Frontier models 95%, Kimi 90% +1");
  });
});

describe("computeGateHealth — blue tier", () => {
  it("blue when serviceMode is non-normal but not a low mode", () => {
    const result = computeGateHealth(
      input({
        serviceMode: { current: "throttled", resetsAt: null },
      }),
    );
    expect(result.tier).toBe("blue");
    expect(result.className).toBe(BLUE_CLASS);
  });
});

describe("computeGateHealth — offending categories & models", () => {
  it("offending categories carry models array", () => {
    const result = computeGateHealth(
      input({
        budgets: [
          budget({
            usedPct: 90,
            models: ["claude-sonnet-4-5", "glm-5.2"],
          }),
        ],
      }),
    );
    expect(result.offendingCategories[0].models).toEqual(["claude-sonnet-4-5", "glm-5.2"]);
  });

  it("offending categories carry mode, overBudgetToday, resetsAt", () => {
    const resets = Date.now() + 3600000;
    const result = computeGateHealth(
      input({
        budgets: [
          budget({
            usedPct: 90,
            mode: "standard",
            overBudgetToday: false,
            resetsAt: resets,
          }),
        ],
      }),
    );
    const cat = result.offendingCategories[0];
    expect(cat.mode).toBe("standard");
    expect(cat.overBudgetToday).toBe(false);
    expect(cat.resetsAt).toBe(resets);
  });

  it("admissionDetail passes through when set", () => {
    const result = computeGateHealth(input({ admissionDetail: "priority low" }));
    expect(result.admissionDetail).toBe("priority low");
  });

  it("admissionDetail undefined when not set", () => {
    const result = computeGateHealth(input());
    expect(result.admissionDetail).toBeUndefined();
  });
});

describe("computeGateHealth — empty budgets", () => {
  it("empty budgets array → admission-only tier", () => {
    const result = computeGateHealth(input({ admissionLabel: "low", budgets: [] }));
    expect(result.tier).toBe("amber");
    expect(result.offendingCategories).toEqual([]);
  });
});

describe("mergePenaltyInput", () => {
  const gateStatsBase: GateStats = {
    active: 1,
    queued: 0,
    softLimit: 4,
    hardCap: 8,
    effectiveLimit: 4,
    tier: "Code Max",
    breaker: "closed",
    boxed: false,
    boxedReason: null,
    boxedUntil: null,
    priorityLow: false,
    unitsDemoted: false,
    demotedUntil: null,
    requestsRemaining: null,
    requestsInWindow: 0,
    requestsLimit: null,
    windowSeconds: null,
    usageOk: true,
    lastUsageFetch: null,
    activeByIntention: {},
    queuedByIntention: {},
    reservations: {},
    serviceMode: { current: "normal", resetsAt: null },
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    windowStartedAt: null,
    windowResetsAt: null,
    windowRemainingMinutes: null,
    watchdog_disabled: false,
    watchdog_consecutive_failures: 0,
    watchdog_failure_window_started_at: null,
    priorityBudgetSummary: {
      category: "frontier",
      label: "Frontier models",
      models: ["umans-glm-5.2"],
      usedPct: 30,
      overBudgetToday: false,
      mode: "interactive",
      resetsAt: null,
    },
  };

  const usageSnapshotBase: UsageSnapshot = {
    ok: true,
    fetchedAt: 0,
    userId: null,
    plan: "Code Max",
    planSlug: null,
    requestsLimit: null,
    requestsHardCap: null,
    requestsWindowSeconds: null,
    concurrencySoftLimit: 4,
    concurrencyHardCap: 8,
    requestsInWindow: 0,
    weightedRequestsInWindow: 0,
    requestsRemaining: null,
    weightedRemainingRequests: null,
    concurrentSessions: 0,
    weightedConcurrentSessions: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    windowStartedAt: null,
    windowResetsAt: null,
    windowRemainingMinutes: null,
    priorityLow: false,
    boxedUntil: null,
    boxedReason: null,
    unitsDemoted: false,
    demotedUntil: null,
    serviceMode: { current: "normal", resetsAt: null },
    priorityBudget: [
      {
        category: "frontier",
        label: "Frontier models",
        models: ["umans-glm-5.2"],
        usedPct: 30,
        overBudgetToday: false,
        mode: "interactive",
        resetsAt: null,
      },
    ],
  };

  it("returns null when both args null", () => {
    expect(mergePenaltyInput(null, null)).toBeNull();
  });

  it("falls back to priorityBudgetSummary single-element array when usageSnapshot null", () => {
    const result = mergePenaltyInput(gateStatsBase, null);
    expect(result).not.toBeNull();
    expect(result?.budgets).toHaveLength(1);
    expect(result?.budgets[0].category).toBe("frontier");
    expect(result?.budgets[0].label).toBe("Frontier models");
    expect(result?.budgets[0].models).toEqual(["umans-glm-5.2"]);
    expect(result?.budgets[0].mode).toBe("interactive");
    expect(result?.admissionLabel).toBe("high");
  });

  it("uses usageSnapshot budgets when available", () => {
    const result = mergePenaltyInput(gateStatsBase, usageSnapshotBase);
    expect(result?.budgets).toHaveLength(1);
    expect(result?.budgets[0].category).toBe("frontier");
  });

  it("derives admissionLabel 'high' from gateStats when normal", () => {
    const result = mergePenaltyInput(gateStatsBase, usageSnapshotBase);
    expect(result?.admissionLabel).toBe("high");
  });

  it("derives admissionLabel 'boxed' when gateStats.boxed true", () => {
    const result = mergePenaltyInput(
      { ...gateStatsBase, boxed: true, boxedUntil: 1893456000000 },
      usageSnapshotBase,
    );
    expect(result?.admissionLabel).toBe("boxed");
    expect(result?.boxed).toBe(true);
    expect(result?.boxedUntil).toBe(1893456000000);
  });

  it("derives admissionLabel 'demoted' when unitsDemoted true", () => {
    const result = mergePenaltyInput(
      { ...gateStatsBase, unitsDemoted: true, demotedUntil: 1893456000000 },
      usageSnapshotBase,
    );
    expect(result?.admissionLabel).toBe("demoted");
    expect(result?.unitsDemoted).toBe(true);
  });

  it("derives admissionLabel 'low' when serviceMode is low mode", () => {
    const result = mergePenaltyInput(
      {
        ...gateStatsBase,
        serviceMode: { current: "low_interactivity", resetsAt: null },
      },
      usageSnapshotBase,
    );
    expect(result?.admissionLabel).toBe("low");
  });

  it("derives admissionLabel 'low' when priorityLow true (no boxing)", () => {
    const result = mergePenaltyInput({ ...gateStatsBase, priorityLow: true }, usageSnapshotBase);
    expect(result?.admissionLabel).toBe("low");
    expect(result?.priorityLow).toBe(true);
  });

  it("passes priorityLow false through mergePenaltyInput", () => {
    const result = mergePenaltyInput(gateStatsBase, usageSnapshotBase);
    expect(result?.priorityLow).toBe(false);
  });

  it("uses usageSnapshot admission fields when gateStats null", () => {
    const result = mergePenaltyInput(null, { ...usageSnapshotBase, priorityLow: true });
    expect(result).not.toBeNull();
    expect(result?.admissionLabel).toBe("low");
    expect(result?.priorityLow).toBe(true);
    expect(result?.budgets).toHaveLength(1);
  });

  it("empty budgets array when both priorityBudget and priorityBudgetSummary null", () => {
    const result = mergePenaltyInput(
      { ...gateStatsBase, priorityBudgetSummary: null },
      { ...usageSnapshotBase, priorityBudget: [] },
    );
    expect(result?.budgets).toEqual([]);
  });

  it("empty budgets array when usageSnapshot null and priorityBudgetSummary null", () => {
    const result = mergePenaltyInput({ ...gateStatsBase, priorityBudgetSummary: null }, null);
    expect(result?.budgets).toEqual([]);
  });
});
