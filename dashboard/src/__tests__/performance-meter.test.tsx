import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PerformanceMeter } from "@/components/performance-meter";
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
    cached_pct: 60.0,
    ttft_p10: 200,
    ttft_p50: 450,
    ttft_p95: 1200,
    tps_p10: 10.5,
    tps_p50: 25.3,
    tps_p95: 40.1,
    ttft_mean: 500,
    tps_mean: 22.0,
  };
  return { row };
});

vi.mock("@/hooks/use-performance-stats", () => ({
  usePerformanceStats: () => ({
    stats: [mockRow.row],
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));

describe("PerformanceMeter", () => {
  it("renders the StatTile grid with model name", () => {
    const { container } = render(<PerformanceMeter />);
    expect(container).toHaveTextContent("claude-sonnet-4-5");
    // StatTile labels are present
    expect(container).toHaveTextContent("TTFT");
    expect(container).toHaveTextContent("TPS");
    expect(container).toHaveTextContent("Total In");
    expect(container).toHaveTextContent("Total Out");
    expect(container).toHaveTextContent("Cached");
  });

  it("TTFT StatTile shows p50 as primary and p10/p95/mean in sub-line", () => {
    const { container } = render(<PerformanceMeter />);

    // p50 = 450 → fmtMs(450) = "450ms"
    expect(container).toHaveTextContent("450ms");
    // p10 = 200 → fmtMs(200) = "200ms"
    expect(container).toHaveTextContent("200ms");
    // p95 = 1200 → fmtMs(1200) = "1.20s"
    expect(container).toHaveTextContent("1.20s");
    // mean = 500 → fmtMs(500) = "500ms"
    expect(container).toHaveTextContent("500ms");
  });

  it("TPS StatTile shows p50 as primary and p10/p95/mean in sub-line", () => {
    const { container } = render(<PerformanceMeter />);

    // p50 = 25.3
    expect(container).toHaveTextContent("25.3");
    // p10 = 10.5
    expect(container).toHaveTextContent("10.5");
    // p95 = 40.1
    expect(container).toHaveTextContent("40.1");
    // mean = 22.0
    expect(container).toHaveTextContent("22.0");
  });

  it("does not render a percentile table or stacked dl", () => {
    const { container } = render(<PerformanceMeter />);

    const table = container.querySelector("table");
    const dls = container.querySelectorAll("dl");

    expect(table).toBeNull();
    expect(dls.length).toBe(0);
  });
});
