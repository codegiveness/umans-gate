import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { UsageTab } from "@/components/usage-tab";
import { flushEffects } from "@/test/utils";
import type { UsageSampleRow } from "@/types";

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
});
