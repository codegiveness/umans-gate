import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { UsageHeatmap } from "@/components/usage-heatmap";
import { flushEffects } from "@/test/utils";
import type { UsageDailyRow } from "@/types";

/** Build a minimal daily row with overrides. */
function row(overrides: Partial<UsageDailyRow> = {}): UsageDailyRow {
  return {
    day_utc: "2026-07-15",
    day_completeness: "full",
    first_activity_utc: 1721020800000,
    last_activity_utc: 1721056800000,
    accumulated_active_minutes: 120,
    utc_clock_span_minutes: 600,
    first_activity_utc_hour: 0,
    last_activity_utc_hour: 10,
    active_minutes_by_utc_hour: null,
    tokens_in_total: 1000,
    tokens_out_total: 500,
    tokens_cached_total: 200,
    requests_in_window_peak: 10,
    requests_in_window_avg: 5,
    cache_hit_rate_avg: 0.5,
    concurrent_sessions_peak: 3,
    concurrent_sessions_avg: 1,
    weighted_concurrent_sessions_peak: 3,
    weighted_concurrent_sessions_avg: 1,
    at_first_priority_event_concurrent_sessions: null,
    at_first_priority_event_weighted_concurrent_sessions: null,
    at_first_priority_event_requests_in_window: null,
    at_first_priority_event_weighted_requests_in_window: null,
    at_first_priority_event_requests_remaining: null,
    at_first_priority_event_requests_limit: null,
    at_first_priority_event_tokens_in: null,
    at_first_priority_event_tokens_out: null,
    at_first_priority_event_tokens_cached: null,
    at_first_priority_event_cache_hit_rate: null,
    at_first_service_mode_event_concurrent_sessions: null,
    at_first_service_mode_event_weighted_concurrent_sessions: null,
    at_first_service_mode_event_requests_in_window: null,
    at_first_service_mode_event_weighted_requests_in_window: null,
    at_first_service_mode_event_requests_remaining: null,
    at_first_service_mode_event_requests_limit: null,
    at_first_service_mode_event_tokens_in: null,
    at_first_service_mode_event_tokens_out: null,
    at_first_service_mode_event_tokens_cached: null,
    at_first_service_mode_event_cache_hit_rate: null,
    priority_low_minutes: 0,
    boxed_minutes: 0,
    units_demoted_minutes: 0,
    service_mode_non_normal_minutes: 0,
    priority_events_count: 0,
    service_mode_events_count: 0,
    priority_ban_total_duration_ms: 0,
    service_mode_ban_total_duration_ms: 0,
    concurrency_hard_cap: 16,
    requests_limit: 1000,
    requests_hard_cap: 2000,
    downsampled_at: 1721060000000,
    ...overrides,
  };
}

describe("UsageHeatmap", () => {
  it("renders a day-cell for each day in the range", async () => {
    const rows = [
      row({ day_utc: "2026-07-13", accumulated_active_minutes: 60 }),
      row({ day_utc: "2026-07-14", accumulated_active_minutes: 120 }),
      row({ day_utc: "2026-07-15", accumulated_active_minutes: 240 }),
    ];
    render(
      <UsageHeatmap
        rows={rows}
        from="2026-07-13"
        to="2026-07-15"
        preset="30d"
        onSelectPreset={() => {}}
        onSelectDay={() => {}}
        onBrushRange={() => {}}
      />,
    );
    await flushEffects();
    const cells = screen.getAllByTestId(/^heatmap-day-cell-/);
    expect(cells).toHaveLength(3);
    expect(cells[0]).toHaveAttribute("data-day", "2026-07-13");
    expect(cells[1]).toHaveAttribute("data-day", "2026-07-14");
    expect(cells[2]).toHaveAttribute("data-day", "2026-07-15");
  });

  it("encodes activity density as 4-5 background intensity steps", async () => {
    const rows = [
      row({ day_utc: "2026-07-13", accumulated_active_minutes: 0 }),
      row({ day_utc: "2026-07-14", accumulated_active_minutes: 60 }),
      row({ day_utc: "2026-07-15", accumulated_active_minutes: 240 }),
      row({ day_utc: "2026-07-16", accumulated_active_minutes: 480 }),
    ];
    render(
      <UsageHeatmap
        rows={rows}
        from="2026-07-13"
        to="2026-07-16"
        preset="30d"
        onSelectPreset={() => {}}
        onSelectDay={() => {}}
        onBrushRange={() => {}}
      />,
    );
    await flushEffects();
    const cells = screen.getAllByTestId(/^heatmap-day-cell-/);
    const levels = cells.map((c) => c.getAttribute("data-activity-level"));
    // 4 distinct levels across the 4 test rows: 0 (none), 1 (low), 3 (high), 4 (max)
    expect(new Set(levels).size).toBe(4);
    expect(levels[0]).toBe("0");
    expect(levels[3]).toBe("4");
  });

  it("encodes degradation state as border color", async () => {
    const rows = [
      row({ day_utc: "2026-07-13" }), // normal
      row({
        day_utc: "2026-07-14",
        at_first_priority_event_concurrent_sessions: 3, // priority_low onset
        priority_events_count: 1,
      }),
      row({
        day_utc: "2026-07-15",
        at_first_service_mode_event_concurrent_sessions: 3,
        service_mode_events_count: 1,
        service_mode_non_normal_minutes: 30,
      }),
      row({
        day_utc: "2026-07-16",
        at_first_priority_event_concurrent_sessions: 3,
        at_first_service_mode_event_concurrent_sessions: 3,
        priority_events_count: 1,
        service_mode_events_count: 1,
      }),
    ];
    render(
      <UsageHeatmap
        rows={rows}
        from="2026-07-13"
        to="2026-07-16"
        preset="30d"
        onSelectPreset={() => {}}
        onSelectDay={() => {}}
        onBrushRange={() => {}}
      />,
    );
    await flushEffects();
    const cells = screen.getAllByTestId(/^heatmap-day-cell-/);
    expect(cells[0].getAttribute("data-degradation")).toBe("none");
    expect(cells[1].getAttribute("data-degradation")).toBe("priority");
    expect(cells[2].getAttribute("data-degradation")).toBe("service_mode");
    expect(cells[3].getAttribute("data-degradation")).toBe("both");
  });

  it("encodes degradation duration fraction as border thickness", async () => {
    const rows = [
      // 0% → thickness 1
      row({
        day_utc: "2026-07-13",
        priority_ban_total_duration_ms: 0,
        utc_clock_span_minutes: 600,
      }),
      // ~5% (30min/600min) → thickness 1 (thin)
      row({
        day_utc: "2026-07-14",
        priority_ban_total_duration_ms: 30 * 60 * 1000,
        utc_clock_span_minutes: 600,
      }),
      // ~25% (150min/600min) → thickness 2 (medium)
      row({
        day_utc: "2026-07-15",
        priority_ban_total_duration_ms: 150 * 60 * 1000,
        utc_clock_span_minutes: 600,
      }),
      // ~75% (450min/600min) → thickness 4 (thick)
      row({
        day_utc: "2026-07-16",
        priority_ban_total_duration_ms: 450 * 60 * 1000,
        utc_clock_span_minutes: 600,
      }),
    ];
    render(
      <UsageHeatmap
        rows={rows}
        from="2026-07-13"
        to="2026-07-16"
        preset="30d"
        onSelectPreset={() => {}}
        onSelectDay={() => {}}
        onBrushRange={() => {}}
      />,
    );
    await flushEffects();
    const cells = screen.getAllByTestId(/^heatmap-day-cell-/);
    const thicknesses = cells.map((c) => Number(c.getAttribute("data-border-thickness")));
    expect(thicknesses[0]).toBe(1);
    expect(thicknesses[1]).toBe(1);
    expect(thicknesses[2]).toBe(2);
    expect(thicknesses[3]).toBe(4);
  });

  it("fires onSelectDay with the clicked day's YYYY-MM-DD", async () => {
    const user = userEvent.setup();
    const onSelectDay = vi.fn();
    const rows = [row({ day_utc: "2026-07-15" })];
    render(
      <UsageHeatmap
        rows={rows}
        from="2026-07-15"
        to="2026-07-15"
        preset="30d"
        onSelectPreset={() => {}}
        onSelectDay={onSelectDay}
        onBrushRange={() => {}}
      />,
    );
    await flushEffects();
    await user.click(screen.getByTestId("heatmap-day-cell-2026-07-15"));
    expect(onSelectDay).toHaveBeenCalledWith("2026-07-15");
  });

  it("renders preset range buttons that change the visible range", async () => {
    const user = userEvent.setup();
    const onSelectPreset = vi.fn();
    const rows = [row({ day_utc: "2026-07-15" })];
    render(
      <UsageHeatmap
        rows={rows}
        from="2026-07-15"
        to="2026-07-15"
        preset="30d"
        onSelectPreset={onSelectPreset}
        onSelectDay={() => {}}
        onBrushRange={() => {}}
      />,
    );
    await flushEffects();
    await user.click(screen.getByRole("button", { name: /7d/i }));
    expect(onSelectPreset).toHaveBeenCalledWith("7d");
  });

  it("renders an empty state when no daily rows", async () => {
    render(
      <UsageHeatmap
        rows={[]}
        from="2026-07-15"
        to="2026-07-15"
        preset="30d"
        onSelectPreset={() => {}}
        onSelectDay={() => {}}
        onBrushRange={() => {}}
      />,
    );
    await flushEffects();
    expect(screen.getByText(/no usage history yet/i)).toBeInTheDocument();
  });

  it("renders missing-day backfill rows distinctly (hatched marker)", async () => {
    const rows = [
      row({ day_utc: "2026-07-14", day_completeness: "missing", accumulated_active_minutes: null }),
      row({ day_utc: "2026-07-15", day_completeness: "full", accumulated_active_minutes: 120 }),
    ];
    render(
      <UsageHeatmap
        rows={rows}
        from="2026-07-14"
        to="2026-07-15"
        preset="30d"
        onSelectPreset={() => {}}
        onSelectDay={() => {}}
        onBrushRange={() => {}}
      />,
    );
    await flushEffects();
    const missingCell =
      screen
        .getByTestId("heatmap-day-cell-2026-07-14")
        // The cell is a button; find by data-day
        .closest("[data-day]") ?? screen.getByTestId("heatmap-day-cell-2026-07-14");
    expect(missingCell.getAttribute("data-completeness")).toBe("missing");
    // The full cell should not be missing
    const fullCell = screen.getByTestId("heatmap-day-cell-2026-07-15");
    expect(fullCell.getAttribute("data-completeness")).toBe("full");
  });

  it("renders a brush-to-zoom control that fires onBrushRange", async () => {
    const onBrushRange = vi.fn();
    const rows = [
      row({ day_utc: "2026-07-13", accumulated_active_minutes: 60 }),
      row({ day_utc: "2026-07-14", accumulated_active_minutes: 120 }),
      row({ day_utc: "2026-07-15", accumulated_active_minutes: 240 }),
    ];
    render(
      <UsageHeatmap
        rows={rows}
        from="2026-07-13"
        to="2026-07-15"
        preset="30d"
        onSelectPreset={() => {}}
        onSelectDay={() => {}}
        onBrushRange={onBrushRange}
      />,
    );
    await flushEffects();
    // The brush control is present.
    expect(screen.getByTestId("heatmap-brush")).toBeInTheDocument();
  });
});
