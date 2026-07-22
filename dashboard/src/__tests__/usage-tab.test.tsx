import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UsageTab } from "@/components/usage-tab";
import { flushEffects } from "@/test/utils";
import type { PriorityBudgetEntry, UsageSampleRow } from "@/types";

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

type UseUsageResult = {
  data: import("@/types").UsageSnapshot | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

const mockUseUsage = vi.hoisted(() =>
  vi.fn<() => UseUsageResult>(() => ({
    data: null,
    loading: false,
    error: null,
    refresh: () => {},
  })),
);

vi.mock("@/hooks/use-usage", () => ({
  useUsage: mockUseUsage,
}));

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
    mode: "priority",
    resetsAt: null,
    ...overrides,
  };
}

function snapshotWith(entries: PriorityBudgetEntry[]): import("@/types").UsageSnapshot {
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
      mockUseUsage.mockReturnValueOnce({
        data: snapshotWith([
          makeBudgetEntry({ label: "Frontier models", usedPct: 0, models: ["umans-glm-5"] }),
          makeBudgetEntry({ label: "Standard models", usedPct: 42, models: ["umans-flash"] }),
        ]),
        loading: false,
        error: null,
        refresh: () => {},
      });
      render(<UsageTab />);
      await flushEffects();
      expect(screen.getByText("Frontier models")).toBeInTheDocument();
      expect(screen.getByText("Standard models")).toBeInTheDocument();
      expect(screen.getByText("0%")).toBeInTheDocument();
      expect(screen.getByText("42%")).toBeInTheDocument();
      expect(screen.getByText(/umans-glm-5/i)).toBeInTheDocument();
      expect(screen.getByText(/umans-flash/i)).toBeInTheDocument();
    });

    it("renders mode badge as lowercase gold badge", async () => {
      mockUseUsage.mockReturnValueOnce({
        data: snapshotWith([makeBudgetEntry({ mode: "Priority" })]),
        loading: false,
        error: null,
        refresh: () => {},
      });
      const { container } = render(<UsageTab />);
      await flushEffects();
      const goldBadge = container.querySelector('[data-variant="secondary"].bg-yellow-100');
      expect(goldBadge).not.toBeNull();
      expect(goldBadge?.textContent).toBe("priority");
    });

    it("renders reset line when overBudgetToday and resetsAt non-null", async () => {
      const resetsAt = Date.now() + 90 * 60 * 1000;
      mockUseUsage.mockReturnValueOnce({
        data: snapshotWith([makeBudgetEntry({ overBudgetToday: true, usedPct: 100, resetsAt })]),
        loading: false,
        error: null,
        refresh: () => {},
      });
      render(<UsageTab />);
      await flushEffects();
      expect(screen.getByText(/resets in/i)).toBeInTheDocument();
    });

    it("renders muted reset line when not over budget and resetsAt non-null", async () => {
      const resetsAt = Date.now() + 90 * 60 * 1000;
      mockUseUsage.mockReturnValueOnce({
        data: snapshotWith([makeBudgetEntry({ overBudgetToday: false, usedPct: 50, resetsAt })]),
        loading: false,
        error: null,
        refresh: () => {},
      });
      render(<UsageTab />);
      await flushEffects();
      expect(screen.getByText(/resets in/i)).toBeInTheDocument();
    });

    it("omits reset line when resetsAt is null", async () => {
      mockUseUsage.mockReturnValueOnce({
        data: snapshotWith([makeBudgetEntry({ resetsAt: null, overBudgetToday: false })]),
        loading: false,
        error: null,
        refresh: () => {},
      });
      render(<UsageTab />);
      await flushEffects();
      expect(screen.queryByText(/resets in/i)).not.toBeInTheDocument();
    });

    it("renders no cards when priorityBudget is empty", async () => {
      mockUseUsage.mockReturnValueOnce({
        data: snapshotWith([]),
        loading: false,
        error: null,
        refresh: () => {},
      });
      render(<UsageTab />);
      await flushEffects();
      expect(screen.queryByText("Frontier models")).not.toBeInTheDocument();
    });

    it("renders no cards when useUsage data is null", async () => {
      mockUseUsage.mockReturnValueOnce({
        data: null,
        loading: false,
        error: null,
        refresh: () => {},
      });
      render(<UsageTab />);
      await flushEffects();
      expect(screen.queryByText("Frontier models")).not.toBeInTheDocument();
    });
  });
});
