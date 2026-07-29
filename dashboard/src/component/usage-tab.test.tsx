import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UsageTab } from "@/components/usage-tab";
import { flushEffects } from "@/test/utils";
import type { PriorityBudgetEntry, UsageSampleRow, UsageSnapshot } from "@/types";

const mockRow = vi.hoisted(() => {
  const row: UsageSampleRow = {
    id: 1,
    fetched_at: Date.now(),
    ok: 1,
    user_id: null,
    plan: "Code Pro",
    plan_slug: "code-pro",
    requests_limit: null,
    requests_hard_cap: null,
    requests_window_seconds: null,
    concurrency_soft_limit: 8,
    concurrency_hard_cap: 16,
    requests_in_window: 0,
    weighted_requests_in_window: 0,
    requests_remaining: null,
    weighted_remaining_requests: null,
    concurrent_sessions: 0,
    weighted_concurrent_sessions: 0,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cached: 0,
    window_started_at: null,
    window_resets_at: null,
    window_remaining_minutes: null,
    priority_low: 0,
    boxed_until: null,
    boxed_reason: null,
    units_demoted: 0,
    demoted_until: null,
    service_mode_current: "normal",
    service_mode_resets_at: null,
  };
  return { row };
});

type UseUsageHistoryResult = {
  samples: UsageSampleRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

const mockUseUsageHistory = vi.hoisted(() =>
  vi.fn<() => UseUsageHistoryResult>(() => ({
    samples: [mockRow.row],
    loading: false,
    error: null,
    refresh: () => {},
  })),
);

vi.mock("@/hooks/use-usage-history", () => ({
  useUsageHistory: mockUseUsageHistory,
}));

vi.mock("@/hooks/use-usage-daily", () => ({
  useUsageDaily: () => ({
    rows: [],
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

vi.mock("@/hooks/use-usage-day", () => ({
  useUsageDay: () => ({
    samples: [],
    events: [],
    daily30Day: null,
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

vi.mock("@/hooks/use-config", () => ({
  useConfig: () => ({
    config: { usage_raw_retention_days: 7 },
    loading: false,
    error: null,
    reload: () => Promise.resolve(null),
    save: () => Promise.resolve(null),
    validate: () => Promise.resolve(null),
    reloadFromDisk: () => Promise.resolve(null),
    refreshFromSource: () => Promise.resolve(null),
    restart: () => Promise.resolve(null),
    resetToDefault: () => Promise.resolve(null),
  }),
}));

function makeBudgetEntry(overrides: Partial<PriorityBudgetEntry> = {}): PriorityBudgetEntry {
  return {
    category: "frontier",
    label: "Frontier models",
    models: ["umans-glm-5", "umans-glm-coder"],
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

describe("UsageTab", () => {
  it("renders the Usage heading", async () => {
    render(<UsageTab />);
    await flushEffects();
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("Usage");
  });

  it("renders a sample row with the plan name", async () => {
    render(<UsageTab />);
    await flushEffects();
    expect(screen.getByText("Code Pro")).toBeInTheDocument();
  });

  it("renders empty state when no samples", async () => {
    mockUseUsageHistory.mockReturnValueOnce({
      samples: [],
      loading: false,
      error: null,
      refresh: () => {},
    });
    render(<UsageTab />);
    await flushEffects();
    expect(screen.getByText(/No usage samples recorded yet/i)).toBeInTheDocument();
  });

  it("renders error state when fetch fails", async () => {
    mockUseUsageHistory.mockReturnValueOnce({
      samples: null,
      loading: false,
      error: "HTTP 500",
      refresh: () => {},
    });
    render(<UsageTab />);
    await flushEffects();
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
  });

  describe("priority budget cards", () => {
    it("renders one card per priorityBudget entry, including 0%", async () => {
      render(
        <UsageTab
          usageSnapshot={snapshotWith([
            makeBudgetEntry({ label: "Frontier models", usedPct: 0, models: ["umans-glm-5"] }),
            makeBudgetEntry({ label: "Standard models", usedPct: 42, models: ["umans-flash"] }),
          ])}
        />,
      );
      await flushEffects();
      expect(screen.getByText("Frontier models")).toBeInTheDocument();
      expect(screen.getByText("Standard models")).toBeInTheDocument();
      expect(screen.getByText("0%")).toBeInTheDocument();
      expect(screen.getByText("42%")).toBeInTheDocument();
      expect(screen.getByText(/umans-glm-5/i)).toBeInTheDocument();
      expect(screen.getByText(/umans-flash/i)).toBeInTheDocument();
    });

    it("renders mode badge as lowercase gold badge", async () => {
      const { container } = render(
        <UsageTab usageSnapshot={snapshotWith([makeBudgetEntry({ mode: "Priority" })])} />,
      );
      await flushEffects();
      const goldBadge = container.querySelector('[data-variant="secondary"].bg-yellow-200');
      expect(goldBadge).not.toBeNull();
      expect(goldBadge?.textContent).toBe("priority");
    });

    it("renders reset line when overBudgetToday and resetsAt non-null", async () => {
      const resetsAt = Date.now() + 90 * 60 * 1000;
      render(
        <UsageTab
          usageSnapshot={snapshotWith([
            makeBudgetEntry({ overBudgetToday: true, usedPct: 100, resetsAt }),
          ])}
        />,
      );
      await flushEffects();
      expect(screen.getByText(/resets in/i)).toBeInTheDocument();
    });

    it("renders muted reset line when not over budget and resetsAt non-null", async () => {
      const resetsAt = Date.now() + 90 * 60 * 1000;
      render(
        <UsageTab
          usageSnapshot={snapshotWith([
            makeBudgetEntry({ overBudgetToday: false, usedPct: 50, resetsAt }),
          ])}
        />,
      );
      await flushEffects();
      expect(screen.getByText(/resets in/i)).toBeInTheDocument();
    });

    it("omits reset line when resetsAt is null", async () => {
      render(
        <UsageTab
          usageSnapshot={snapshotWith([
            makeBudgetEntry({ resetsAt: null, overBudgetToday: false }),
          ])}
        />,
      );
      await flushEffects();
      expect(screen.queryByText(/resets in/i)).not.toBeInTheDocument();
    });

    it("renders no cards when priorityBudget is empty", async () => {
      render(<UsageTab usageSnapshot={snapshotWith([])} />);
      await flushEffects();
      expect(screen.queryByText("Frontier models")).not.toBeInTheDocument();
    });

    it("renders no cards when usageSnapshot is null", async () => {
      render(<UsageTab usageSnapshot={null} />);
      await flushEffects();
      expect(screen.queryByText("Frontier models")).not.toBeInTheDocument();
    });
  });

  describe("PenaltyBadge mount", () => {
    it("renders PenaltyBadge above PriorityBudgetCards in DOM order", async () => {
      const { container } = render(
        <UsageTab
          usageSnapshot={snapshotWith([makeBudgetEntry({ label: "Frontier models", usedPct: 95 })])}
        />,
      );
      await flushEffects();
      const badges = container.querySelectorAll("[data-slot='badge']");
      const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
      // PenaltyBadge pill text "Frontier models 95%" appears.
      expect(badgeTexts).toContain("Frontier models 95%");
      // PriorityBudgetCards also renders a card with the same heading, but
      // the PenaltyBadge badge slot is the first `[data-slot='badge']`
      // matching "Frontier models 95%".
      const firstMatchingIdx = badgeTexts.indexOf("Frontier models 95%");
      expect(firstMatchingIdx).toBeGreaterThanOrEqual(0);
      // A card heading "Frontier models" must appear after the badge.
      const allNodes = Array.from(container.querySelectorAll("*"));
      const badgeNode = allNodes.find((n) => n.textContent?.trim() === "Frontier models 95%");
      const cardHeadingNode = screen
        .getAllByText("Frontier models")
        .find((el) => el.tagName === "H3");
      expect(badgeNode).toBeDefined();
      expect(cardHeadingNode).toBeDefined();
      // Compare document order: badge before card heading.
      if (badgeNode && cardHeadingNode) {
        const rel = badgeNode.compareDocumentPosition(cardHeadingNode);
        // Node.DOCUMENT_POSITION_FOLLOWING = 4
        expect(rel & 4).toBe(4);
      }
    });

    it("shows correct label for penalties (frontier 85% when over 80%)", async () => {
      const { container } = render(
        <UsageTab
          usageSnapshot={snapshotWith([
            makeBudgetEntry({ label: "frontier", usedPct: 85, mode: "interactive" }),
          ])}
        />,
      );
      await flushEffects();
      expect(container).toHaveTextContent("frontier 85%");
    });

    it("shows healthy when no penalties (all budgets interactive, under 80%, not over budget)", async () => {
      const { container } = render(
        <UsageTab
          usageSnapshot={snapshotWith([
            makeBudgetEntry({ usedPct: 30, mode: "interactive", overBudgetToday: false }),
          ])}
        />,
      );
      await flushEffects();
      const badges = container.querySelectorAll("[data-slot='badge']");
      const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
      expect(badgeTexts).toContain("healthy");
    });

    it("renders null PenaltyBadge when usageSnapshot is null (no badge pill)", async () => {
      const { container } = render(<UsageTab usageSnapshot={null} />);
      await flushEffects();
      // With null usageSnapshot, mergePenaltyInput returns null and
      // PenaltyBadge renders nothing. No badge slot should be present
      // that has a health-related label ("healthy"/"boxed"/etc.).
      const badges = container.querySelectorAll("[data-slot='badge']");
      const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
      expect(badgeTexts).not.toContain("healthy");
      expect(badgeTexts).not.toContain("boxed");
    });
  });
});
