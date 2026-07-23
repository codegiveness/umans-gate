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

describe("GateStatus merged gate health badge", () => {
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

  it("shows high badge when priorityBudgetSummary is null", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("high");
    expect(badgeTexts.some((t) => t.includes("frontier"))).toBe(false);
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

describe("GateStatus merged badge label composition", () => {
  it("shows 'interactive · frontier 49%' when service mode interactive + budget 49%", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "interactive", resetsAt: null },
          priorityBudgetSummary: budget({ usedPct: 49, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("interactive · frontier 49%");
  });

  it("shows 'frontier 87% · interactive' when service mode interactive + budget 87%", async () => {
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
    expect(badgeTexts).toContain("frontier 87% · interactive");
  });

  it("shows 'boxed · frontier 49%' when boxed + budget", async () => {
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
    expect(badgeTexts).toContain("boxed · frontier 49%");
  });

  it("shows worst-tier amber when interactive + budget >= 80%", async () => {
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
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("frontier 85% · interactive");
    const mergedBadge = Array.from(badges).find(
      (b) => b.textContent?.trim() === "frontier 85% · interactive",
    );
    expect(mergedBadge?.className).toContain("bg-amber");
    expect(mergedBadge?.className).not.toContain("bg-blue");
  });

  it("shows worst-tier red (destructive) when boxed + budget", async () => {
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
    const mergedBadge = Array.from(badges).find(
      (b) => b.textContent?.trim() === "boxed · frontier 49%",
    );
    expect(mergedBadge?.className).toContain("text-destructive");
  });
});

describe("GateStatus merged badge tooltip sections", () => {
  it("shows 'All systems nominal' when high and no budget", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    expect(container).toHaveTextContent("All systems nominal");
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
    expect(container).not.toHaveTextContent("priority high");
    expect(container).not.toHaveTextContent("All systems nominal");
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
    expect(container).not.toHaveTextContent("used");
    expect(container).not.toHaveTextContent("% used");
  });

  it("badge is always present when stats is non-null", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    const badges = container.querySelectorAll("[data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("high");
  });

  it("shows both admission detail and budget detail in tooltip when both present", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "interactive", resetsAt: null },
          priorityBudgetSummary: budget({ usedPct: 49, overBudgetToday: false }),
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("service mode: interactive");
    expect(container).toHaveTextContent("Frontier models");
    const hr = container.querySelector("hr");
    expect(hr).not.toBeNull();
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
    expect(container).toHaveTextContent("reason: rate_limit_exceeded");
    expect(container).toHaveTextContent("boxed until");
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
    expect(container).toHaveTextContent("demoted until");
  });
});
