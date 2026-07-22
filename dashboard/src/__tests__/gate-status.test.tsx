import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GateStatus } from "@/components/gate-status";
import { flushEffects } from "@/test/utils";
import type { GateStats } from "@/types";

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
  it("renders high priority badge when normal", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    expect(container).toHaveTextContent("high");
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
    const badges = container.querySelectorAll("[class*='badge'], [data-slot='badge']");
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
    expect(container).toHaveTextContent("service mode: degraded");
    expect(container).toHaveTextContent("resets at");
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
    expect(container).toHaveTextContent("low");
    expect(container).not.toHaveTextContent("high");
  });

  it("renders watchdog off badge when watchdog_disabled", async () => {
    const { container } = render(
      <GateStatus
        stats={{ ...baseStats, watchdog_disabled: true, watchdog_consecutive_failures: 3 }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("watchdog off");
  });

  it("does not render watchdog off badge when watchdog not disabled", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    expect(container).not.toHaveTextContent("watchdog off");
  });
});

describe("GateStatus priority budget badge", () => {
  const budget = (overrides: Partial<GateStats["priorityBudgetSummary"]> = null) => {
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
  };

  it("renders blue badge when usedPct below 80 and not over budget", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({ usedPct: 11, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("frontier 11%");
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("frontier 11%");
    const budgetBadge = Array.from(badges).find((b) => b.textContent?.trim() === "frontier 11%");
    expect(budgetBadge?.className).toContain("bg-blue");
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
    expect(container).toHaveTextContent("frontier 85%");
    const badges = container.querySelectorAll("[data-slot='badge']");
    const budgetBadge = Array.from(badges).find((b) => b.textContent?.trim() === "frontier 85%");
    expect(budgetBadge?.className).toContain("bg-amber");
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
    expect(container).toHaveTextContent("frontier 50%");
    const badges = container.querySelectorAll("[data-slot='badge']");
    const budgetBadge = Array.from(badges).find((b) => b.textContent?.trim() === "frontier 50%");
    expect(budgetBadge?.className).toContain("text-destructive");
  });

  it("does not render budget badge when priorityBudgetSummary is null", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts.some((t) => t.includes("frontier"))).toBe(false);
  });

  it("does not render budget badge when usage is stale", async () => {
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
  });

  it("tooltip includes models, mode, and reset time when resetsAt is non-null", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({
            models: ["umans-glm-5.2", "umans-o3"],
            mode: "standard",
            resetsAt: 1893456000000,
          }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Frontier models");
    expect(container).toHaveTextContent("umans-glm-5.2");
    expect(container).toHaveTextContent("umans-o3");
    expect(container).toHaveTextContent("mode: standard");
    expect(container).toHaveTextContent("resets in");
  });

  it("omits reset time line when resetsAt is null", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityBudgetSummary: budget({ resetsAt: null }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Frontier models");
    expect(container).not.toHaveTextContent("resets in");
  });
});
