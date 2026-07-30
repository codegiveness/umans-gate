import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GateStatus } from "@/components/gate-status";
import { flushEffects } from "@/test/utils";
import type { GateStats, PriorityBudgetEntry, UsageSnapshot } from "@/types";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const baseStats: GateStats = {
  usageOk: true,
  lastUsageFetch: null,
  active: 1,
  hardCap: 8,
  softLimit: 4,
  effectiveLimit: 4,
  queued: 0,
  tier: "Code Max",
  breaker: "closed",
  priorityLow: false,
  boxed: false,
  boxedUntil: null,
  boxedReason: null,
  unitsDemoted: false,
  demotedUntil: null,
  requestsLimit: null,
  requestsInWindow: 0,
  requestsRemaining: null,
  windowSeconds: null,
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
  priorityBudgetSummary: null,
};

describe("GateStatus service mode", () => {
  it("renders healthy badge when normal", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    expect(container).toHaveTextContent("healthy");
  });

  it("renders low badge when service mode is low_interactivity", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "low_interactivity", resetsAt: null },
        }}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("low");
    expect(badgeTexts).not.toContain("low_interactivity");
  });

  it("shows tooltip with service mode details", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "degraded", resetsAt: 1893456000000 },
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("service_mode: degraded");
    expect(container).toHaveTextContent("resets_at");
  });

  it("renders demoted badge when units demoted", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          unitsDemoted: true,
          demotedUntil: 1893456000000,
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("demoted");
  });

  it("renders only one status badge, not separate priority + service mode", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityLow: false,
          serviceMode: { current: "low_interactivity", resetsAt: null },
        }}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("low");
    expect(badgeTexts).not.toContain("healthy");
  });

  it("does not render watchdog off badge when watchdog not disabled", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    expect(container).not.toHaveTextContent("watchdog off");
  });
});

function budget(
  overrides: Partial<NonNullable<GateStats["priorityBudgetSummary"]>> | null,
): NonNullable<GateStats["priorityBudgetSummary"]> | null {
  if (overrides === null) return null;
  return {
    category: "frontier",
    label: "Frontier models",
    models: ["umans-glm-5.2", "umans-o3"],
    usedPct: 11,
    overBudgetToday: false,
    mode: "standard",
    resetsAt: 1893456000000,
    ...overrides,
  };
}

describe("GateStatus penalty badge", () => {
  it("renders healthy badge when priorityBudgetSummary is null", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("healthy");
    expect(badgeTexts.some((t) => t.includes("frontier"))).toBe(false);
  });

  it("falls back to priorityBudgetSummary when usageSnapshot is null", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({ usedPct: 85, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Frontier models 85%");
  });

  it("hides budget segment when usage is stale", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          usageOk: false,
          priorityBudgetSummary: budget({ usedPct: 11 }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("usage: stale");
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts.some((t) => t.includes("frontier"))).toBe(false);
    expect(badgeTexts).toContain("healthy");
  });

  it("renders amber badge when usedPct at 85 and not over budget", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({ usedPct: 85, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Frontier models 85%");
    const badges = container.querySelectorAll("[data-slot='badge']");
    const budgetBadge = Array.from(badges).find((b) =>
      b.textContent?.trim().includes("Frontier models 85%"),
    );
    expect(budgetBadge?.className).toContain("bg-amber-500");
  });

  it("renders red badge when overBudgetToday is true", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({ usedPct: 50, overBudgetToday: true }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Frontier models 50%");
    const badges = container.querySelectorAll("[data-slot='badge']");
    const budgetBadge = Array.from(badges).find((b) =>
      b.textContent?.trim().includes("Frontier models 50%"),
    );
    expect(budgetBadge?.className).toContain("text-destructive");
  });

  it("tooltip includes models, mode, and reset time when budget is present", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({
            models: ["umans-glm-5.2", "umans-o3"],
            mode: "standard",
            resetsAt: 1893456000000,
            usedPct: 85,
          }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Frontier models");
    expect(container).toHaveTextContent("umans-glm-5.2");
    expect(container).toHaveTextContent("umans-o3");
    expect(container).toHaveTextContent("Throttled: standard");
    expect(container).toHaveTextContent("resets in");
  });

  it("omits reset time line when resetsAt is null", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({ resetsAt: null, usedPct: 85 }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Frontier models");
    expect(container).not.toHaveTextContent("resets in");
  });
});

describe("GateStatus penalty badge label composition", () => {
  it("shows admission label only when service mode interactive + budget below 80%", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "interactive", resetsAt: null },
          priorityBudgetSummary: budget({
            usedPct: 49,
            overBudgetToday: false,
            mode: "interactive",
          }),
        }}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("interactive");
  });

  it("shows offending budget only when budget >= 80%", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "interactive", resetsAt: null },
          priorityBudgetSummary: budget({ usedPct: 87, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("Frontier models 87%");
  });

  it("shows boxed label when boxed", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          boxed: true,
          boxedReason: "rate_limit_exceeded",
          boxedUntil: 1893456000000,
          priorityBudgetSummary: budget({ usedPct: 49, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts.some((t) => t.startsWith("boxed"))).toBe(true);
  });

  it("shows amber tier when interactive + budget >= 80%", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "interactive", resetsAt: null },
          priorityBudgetSummary: budget({ usedPct: 85, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const mergedBadge = Array.from(badges).find((b) =>
      b.textContent?.trim().includes("Frontier models 85%"),
    );
    expect(mergedBadge?.className).toContain("bg-amber-500");
  });

  it("shows red tier (destructive) when boxed + budget", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          boxed: true,
          boxedReason: "rate_limit_exceeded",
          boxedUntil: 1893456000000,
          priorityBudgetSummary: budget({ usedPct: 49, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const mergedBadge = Array.from(badges).find((b) => b.textContent?.trim().startsWith("boxed"));
    expect(mergedBadge?.className).toContain("text-destructive");
  });
});

describe("GateStatus penalty badge tooltip sections", () => {
  it("shows 'All systems nominal' when healthy and no budget", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    expect(container).toHaveTextContent("All categories healthy — no throttling active");
  });

  it("omits admission detail when state is high", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({ usedPct: 49, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    expect(container).not.toHaveTextContent("service mode:");
  });

  it("omits budget section when no budget data", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "interactive", resetsAt: null },
        }}
      />,
    );
    await flushEffects();
    expect(container).not.toHaveTextContent("Frontier models");
  });

  it("badge is always present when stats is non-null", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("healthy");
  });

  it("shows both admission detail and budget detail in tooltip when both present", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "interactive", resetsAt: null },
          priorityBudgetSummary: budget({ usedPct: 85, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("service_mode: normal");
    expect(container).toHaveTextContent("Frontier models");
  });

  it("shows boxedReason and boxedUntil in tooltip when boxed", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          boxed: true,
          boxedReason: "rate_limit_exceeded",
          boxedUntil: 1893456000000,
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Reason: rate_limit_exceeded");
    expect(container).toHaveTextContent("boxed_until");
  });

  it("shows demotedUntil in tooltip when demoted", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          unitsDemoted: true,
          demotedUntil: 1893456000000,
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("demoted_until");
  });

  it("shows Account-wide tooltip when boxed with no offending budgets", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          boxed: true,
          boxedReason: "rate_limit_exceeded",
          boxedUntil: 1893456000000,
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Affects all models on this account");
  });

  it("renders exactly one status badge when service mode interactive with usageSnapshot", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "interactive", resetsAt: null },
        }}
        usageSnapshot={{
          ...snapshotWith([makeBudgetEntry({ usedPct: 30, mode: "interactive" })]),
          serviceMode: { current: "interactive", resetsAt: null },
        }}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    // Regression: ServiceModeBadge used to render "interactive" → two pills
    expect(badgeTexts.filter((t) => t === "interactive")).toHaveLength(1);
  });

  it("shows service_mode and priority tuple in tooltip when nominal", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "interactive", resetsAt: null },
        }}
        usageSnapshot={{
          ...snapshotWith([makeBudgetEntry({ usedPct: 30, mode: "interactive" })]),
          serviceMode: { current: "interactive", resetsAt: null },
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("service_mode:");
    expect(container).toHaveTextContent("Priority:");
  });
});

function makeBudgetEntry(overrides: Partial<PriorityBudgetEntry> = {}): PriorityBudgetEntry {
  return {
    category: "frontier",
    label: "Frontier models",
    models: ["umans-glm-5.2", "umans-o3"],
    usedPct: 50,
    overBudgetToday: false,
    mode: "interactive",
    resetsAt: null,
    ...overrides,
  };
}

function snapshotWith(entries: PriorityBudgetEntry[]): UsageSnapshot {
  return {
    ok: true,
    fetchedAt: Date.now(),
    userId: null,
    plan: "Code Pro",
    planSlug: "code-pro",
    requestsLimit: null,
    requestsHardCap: null,
    requestsWindowSeconds: null,
    concurrencySoftLimit: 8,
    concurrencyHardCap: 16,
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
    priorityBudget: entries,
  };
}

describe("GateStatus multi-budget usageSnapshot prop", () => {
  it("renders both offending categories from usageSnapshot, not just priorityBudgetSummary", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({ usedPct: 11 }),
        }}
        usageSnapshot={snapshotWith([
          makeBudgetEntry({ label: "Frontier models", usedPct: 95 }),
          makeBudgetEntry({
            category: "kimi",
            label: "Kimi models",
            usedPct: 88,
            models: ["umans-kimi-k3"],
          }),
        ])}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Frontier models 95%");
    expect(container).toHaveTextContent("Kimi models 88%");
  });

  it("uses usageSnapshot priorityBudget over priorityBudgetSummary when both present", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({ usedPct: 11, label: "WS summary label" }),
        }}
        usageSnapshot={snapshotWith([makeBudgetEntry({ label: "Poll Frontier", usedPct: 85 })])}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Poll Frontier 85%");
    expect(container).not.toHaveTextContent("WS summary label");
  });

  it("falls back to priorityBudgetSummary when usageSnapshot is null", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({ usedPct: 85 }),
        }}
        usageSnapshot={null}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Frontier models 85%");
  });

  it("renders healthy when usageSnapshot has only healthy budgets", async () => {
    const { container } = render(
      <GateStatus
        stats={baseStats}
        usageSnapshot={snapshotWith([makeBudgetEntry({ usedPct: 30, mode: "interactive" })])}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("healthy");
  });
});
