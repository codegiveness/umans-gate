import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PerformanceMeter } from "@/components/performance-meter";
import { flushEffects } from "@/test/utils";
import type { PerformanceStatsRow } from "@/types";

const mockRow = vi.hoisted(() => {
  const row: PerformanceStatsRow = {
    model: "claude-sonnet-4-5",
    provider: "anthropic",
    request_count: 10,
    streaming_count: 8,
    total_input_tokens: 50000,
    total_output_tokens: 12000,
    total_cache_read_tokens: 30000,
    total_thinking_tokens: 3000,
    requests_with_thinking: 5,
    cached_pct: 60.0,
    ttft_mean: 500,
    ttft_max: 800,
    ttft_p10: 200,
    ttft_p50: 450,
    ttft_p95: 800,
    ttft_outlier_count: 0,
    tps_mean: 22.0,
    tps_min: 12.0,
    tps_p10: 15.0,
    tps_p50: 22.0,
    tps_p95: 30.0,
    tps_outlier_count: 0,
  };
  return { row };
});

type UsePerformanceStatsResult = {
  stats: PerformanceStatsRow[] | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
};

const mockUsePerformanceStats = vi.hoisted(() =>
  vi.fn<() => UsePerformanceStatsResult>(() => ({
    stats: [mockRow.row],
    loading: false,
    error: null,
    refresh: () => {},
  })),
);

vi.mock("@/hooks/use-performance-stats", () => ({
  usePerformanceStats: mockUsePerformanceStats,
}));

describe("PerformanceMeter", () => {
  it("renders the StatTile grid with model name", async () => {
    const { container } = render(<PerformanceMeter />);
    await flushEffects();
    expect(container).toHaveTextContent("claude-sonnet-4-5");
    // StatTile labels are present
    expect(container).toHaveTextContent("TTFT");
    expect(container).toHaveTextContent("TPS");
    expect(container).toHaveTextContent("Total In");
    expect(container).toHaveTextContent("Total Out");
    expect(container).toHaveTextContent("Cache Hit");
  });

  it("TTFT StatTile shows average primary value and avg label", async () => {
    const { container } = render(<PerformanceMeter />);
    await flushEffects();

    // Mean TTFT = 500ms
    expect(container).toHaveTextContent("500ms");
    // AVG label shown next to primary value
    expect(container).toHaveTextContent("AVG");
    // Max sub-line: 800ms MAX
    expect(container).toHaveTextContent("800ms");
    expect(container).toHaveTextContent("MAX");
    // Percentile sub-line: p10: 200ms · p50: 450ms · p95: 800ms
    expect(container).toHaveTextContent("p10: 200ms");
    expect(container).toHaveTextContent("p50: 450ms");
    expect(container).toHaveTextContent("p95: 800ms");
  });

  it("TPS StatTile shows average primary value and avg label", async () => {
    const { container } = render(<PerformanceMeter />);
    await flushEffects();

    // Mean TPS = 22.0
    expect(container).toHaveTextContent("22.0");
    // AVG label shown next to primary value
    expect(container).toHaveTextContent("AVG");
    // Min sub-line: 12.0 MIN
    expect(container).toHaveTextContent("12.0");
    expect(container).toHaveTextContent("MIN");
    // Percentile sub-line: p10: 15.0 · p50: 22.0 · p95: 30.0
    expect(container).toHaveTextContent("p10: 15.0");
    expect(container).toHaveTextContent("p50: 22.0");
    expect(container).toHaveTextContent("p95: 30.0");
  });

  it("does not render a percentile table or stacked dl", async () => {
    const { container } = render(<PerformanceMeter />);
    await flushEffects();

    const table = container.querySelector("table");
    const dls = container.querySelectorAll("dl");

    expect(table).toBeNull();
    expect(dls.length).toBe(0);
  });

  it("badge shows total request count", async () => {
    const { container } = render(<PerformanceMeter />);
    await flushEffects();

    // mockRow: request_count = 10
    expect(container).toHaveTextContent("10 req");
  });

  it("Total Out tile shows thinking tokens with percentage of total output when present", async () => {
    const { container } = render(<PerformanceMeter />);
    await flushEffects();

    // mockRow: total_thinking_tokens = 3000, total_output_tokens = 12000 → 25.0%
    expect(container).toHaveTextContent("3.0K think");
    expect(container).toHaveTextContent("(25.0%)");
  });

  it("Total Out tile shows thinking count without percentage when output is zero", async () => {
    mockUsePerformanceStats.mockReturnValueOnce({
      stats: [{ ...mockRow.row, total_output_tokens: 0, total_thinking_tokens: 3000 }],
      loading: false,
      error: null,
      refresh: () => {},
    });

    const { container } = render(<PerformanceMeter />);
    await flushEffects();

    expect(container).toHaveTextContent("3.0K think");
    expect(container.textContent).not.toMatch(/think \(\d+\.\d+%\)/);
  });

  it("omits thinking sub on Total Out when zero tokens and zero requests with thinking", async () => {
    mockUsePerformanceStats.mockReturnValueOnce({
      stats: [{ ...mockRow.row, total_thinking_tokens: 0, requests_with_thinking: 0 }],
      loading: false,
      error: null,
      refresh: () => {},
    });

    const { container } = render(<PerformanceMeter />);
    await flushEffects();

    expect(container).not.toHaveTextContent("think");
    expect(container).not.toHaveTextContent("reason");
  });

  it("Total Out tile shows unmeasured thinking when tokens absent but requests had thinking", async () => {
    mockUsePerformanceStats.mockReturnValueOnce({
      stats: [{ ...mockRow.row, total_thinking_tokens: 0, requests_with_thinking: 7 }],
      loading: false,
      error: null,
      refresh: () => {},
    });

    const { container } = render(<PerformanceMeter />);
    await flushEffects();

    expect(container).toHaveTextContent("7 req w/ think (unmeasured)");
  });

  it("keeps model cards visible when error and stats coexist", async () => {
    mockUsePerformanceStats.mockReturnValueOnce({
      stats: [mockRow.row],
      loading: false,
      error: "Failed to fetch",
      refresh: () => {},
    });

    const { container } = render(<PerformanceMeter />);
    await flushEffects();

    expect(container).toHaveTextContent("claude-sonnet-4-5");
    expect(container).toHaveTextContent("Failed to refresh");
    expect(container).not.toHaveTextContent("Retry");
  });
});
