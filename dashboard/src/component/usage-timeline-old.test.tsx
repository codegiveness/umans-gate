import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UsageTimelineOld } from "@/components/usage-timeline-old";
import { flushEffects } from "@/test/utils";
import type { UsageDailyRow, UsageEventRow } from "@/types";

/** Build a minimal daily row with overrides. */
function daily(overrides: Partial<UsageDailyRow> = {}): UsageDailyRow {
  return {
    day_utc: "2026-06-15",
    day_completeness: "full",
    first_activity_utc: 1781481600000,
    last_activity_utc: 1781568000000,
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
    cache_hit_rate_avg: 0.68,
    concurrent_sessions_peak: 3,
    concurrent_sessions_avg: 1,
    weighted_concurrent_sessions_peak: 3,
    weighted_concurrent_sessions_avg: 1,
    at_first_priority_event_concurrent_sessions: 2,
    at_first_priority_event_weighted_concurrent_sessions: 2,
    at_first_priority_event_requests_in_window: 4,
    at_first_priority_event_weighted_requests_in_window: 4,
    at_first_priority_event_requests_remaining: 996,
    at_first_priority_event_requests_limit: 1000,
    at_first_priority_event_tokens_in: 100,
    at_first_priority_event_tokens_out: 50,
    at_first_priority_event_tokens_cached: 200,
    at_first_priority_event_cache_hit_rate: 0.5,
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
    priority_low_minutes: 60,
    boxed_minutes: 0,
    units_demoted_minutes: 0,
    service_mode_non_normal_minutes: 0,
    priority_events_count: 1,
    service_mode_events_count: 0,
    priority_ban_total_duration_ms: 3600000,
    service_mode_ban_total_duration_ms: 0,
    concurrency_hard_cap: 16,
    requests_limit: 1000,
    requests_hard_cap: 2000,
    downsampled_at: 1781654400000,
    ...overrides,
  };
}

/** Build a minimal event row with overrides. */
function event(overrides: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    id: 1,
    onset_at: 1781481600000,
    transition: "onset",
    tuple_kind: "priority",
    previous_event_id: null,
    fetched_at: 1781481600000,
    ok: 1,
    user_id: null,
    plan: "Code Pro",
    plan_slug: "code-pro",
    requests_limit: 1000,
    requests_hard_cap: 2000,
    requests_window_seconds: null,
    concurrency_soft_limit: 8,
    concurrency_hard_cap: 16,
    requests_in_window: 5,
    weighted_requests_in_window: 5,
    requests_remaining: 995,
    weighted_remaining_requests: 995,
    concurrent_sessions: 3,
    weighted_concurrent_sessions: 3,
    tokens_in: 100,
    tokens_out: 50,
    tokens_cached: 200,
    cache_hit_rate: 0.5,
    window_started_at: null,
    window_resets_at: null,
    window_remaining_minutes: null,
    priority_low: 1,
    boxed_until: null,
    boxed_reason: null,
    units_demoted: 0,
    demoted_until: null,
    service_mode_current: "normal",
    service_mode_resets_at: null,
    ...overrides,
  };
}

describe("UsageTimelineOld", () => {
  it("renders 5 lanes for an old day from daily + events (not raw samples)", async () => {
    const d = daily();
    const events = [
      event({ id: 1, onset_at: 1781481600000, transition: "onset", tuple_kind: "priority" }),
      event({
        id: 2,
        onset_at: 1781485200000,
        transition: "resolved",
        tuple_kind: "priority",
        priority_low: 0,
      }),
    ];
    render(
      <UsageTimelineOld
        dayUtc="2026-06-15"
        daily={d}
        events={events}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    expect(screen.getByTestId("usage-timeline-old")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-lane-concurrency")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-lane-requests")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-lane-tokens")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-lane-cache-hit")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-lane-degradation")).toBeInTheDocument();
  });

  it("renders dashed held-constant segments between events (step-function)", async () => {
    const d = daily();
    const events = [
      event({ id: 1, onset_at: 1781481600000, concurrent_sessions: 2 }),
      event({
        id: 2,
        onset_at: 1781485200000,
        concurrent_sessions: 5,
        transition: "resolved",
        priority_low: 0,
      }),
    ];
    render(
      <UsageTimelineOld
        dayUtc="2026-06-15"
        daily={d}
        events={events}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    const lane = screen.getByTestId("timeline-lane-concurrency");
    expect(lane.getAttribute("data-render-mode")).toBe("dashed-step");
    const steps = JSON.parse(lane.getAttribute("data-step-points") ?? "[]") as number[];
    expect(steps).toContain(1781481600000);
    expect(steps).toContain(1781485200000);
  });

  it("renders event markers at exact timestamps with ambient context in tooltip data", async () => {
    const d = daily();
    const events = [
      event({
        id: 1,
        onset_at: 1781481600000,
        transition: "onset",
        tuple_kind: "priority",
        concurrent_sessions: 7,
        tokens_in: 250,
        cache_hit_rate: 0.42,
      }),
    ];
    render(
      <UsageTimelineOld
        dayUtc="2026-06-15"
        daily={d}
        events={events}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    const lane = screen.getByTestId("timeline-lane-concurrency");
    const markers = JSON.parse(lane.getAttribute("data-event-markers") ?? "[]") as Array<{
      onset_at: number;
      concurrent_sessions: number;
    }>;
    expect(markers).toHaveLength(1);
    expect(markers[0].onset_at).toBe(1781481600000);
    expect(markers[0].concurrent_sessions).toBe(7);
  });

  it("degradation bands span real onset to real resolution (accurate, not extrapolated)", async () => {
    const d = daily();
    const onset = 1781481600000;
    const resolution = 1781488800000;
    const events = [
      event({ id: 1, onset_at: onset, transition: "onset", tuple_kind: "priority" }),
      event({
        id: 2,
        onset_at: resolution,
        transition: "resolved",
        tuple_kind: "priority",
        priority_low: 0,
      }),
    ];
    render(
      <UsageTimelineOld
        dayUtc="2026-06-15"
        daily={d}
        events={events}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    const lane = screen.getByTestId("timeline-lane-degradation");
    const bands = JSON.parse(lane.getAttribute("data-priority-bands-real") ?? "[]") as Array<{
      from: number;
      to: number;
    }>;
    expect(bands).toHaveLength(1);
    expect(bands[0].from).toBe(onset);
    expect(bands[0].to).toBe(resolution);
  });

  it("renders empty state when no daily row and no events for the day", async () => {
    render(
      <UsageTimelineOld
        dayUtc="2026-06-15"
        daily={null}
        events={[]}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    expect(screen.getByTestId("timeline-old-empty-state")).toBeInTheDocument();
  });

  it("renders flat dashed line at daily aggregate peak/avg when day has zero events", async () => {
    const d = daily({
      concurrent_sessions_peak: 4,
      concurrent_sessions_avg: 2,
      tokens_in_total: 500,
      tokens_out_total: 250,
      tokens_cached_total: 100,
      cache_hit_rate_avg: 0.6,
    });
    render(
      <UsageTimelineOld
        dayUtc="2026-06-15"
        daily={d}
        events={[]}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    const concurrencyLane = screen.getByTestId("timeline-lane-concurrency");
    expect(concurrencyLane.getAttribute("data-render-mode")).toBe("dashed-flat");
    // Flat line uses daily peak as the held-constant value.
    expect(concurrencyLane.getAttribute("data-flat-peak")).toBe("4");
    // day_completeness is surfaced so the user can tell "no activity" from "incomplete data".
    const root = screen.getByTestId("usage-timeline-old");
    expect(root.getAttribute("data-day-completeness")).toBe("full");
  });
});
