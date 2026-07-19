import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UsageTimeline } from "@/components/usage-timeline";
import { flushEffects } from "@/test/utils";
import type { UsageDailyRow, UsageEventRow, UsageSampleRow } from "@/types";

/** Build a minimal sample row with overrides. */
function sample(overrides: Partial<UsageSampleRow> = {}): UsageSampleRow {
  return {
    id: 1,
    fetched_at: 1720000000000,
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
    ...overrides,
  };
}

/** Build a minimal event row with overrides. */
function event(overrides: Partial<UsageEventRow> = {}): UsageEventRow {
  return {
    id: 1,
    onset_at: 1720000000000,
    transition: "onset",
    tuple_kind: "priority",
    previous_event_id: null,
    fetched_at: 1720000000000,
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

/** Build a minimal daily row with overrides. */
function daily(overrides: Partial<UsageDailyRow> = {}): UsageDailyRow {
  return {
    day_utc: "2026-07-15",
    day_completeness: "full",
    first_activity_utc: 1720000000000,
    last_activity_utc: 1720086400000,
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
    downsampled_at: 1720090000000,
    ...overrides,
  };
}

describe("UsageTimeline", () => {
  it("renders 5 lanes for a selected day", async () => {
    const samples = [
      sample({ id: 1, fetched_at: 1720000000000 }),
      sample({ id: 2, fetched_at: 1720003600000 }),
    ];
    render(
      <UsageTimeline
        dayUtc="2026-07-15"
        samples={samples}
        events={[]}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    expect(screen.getByTestId("timeline-lane-concurrency")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-lane-requests")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-lane-tokens")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-lane-cache-hit")).toBeInTheDocument();
    expect(screen.getByTestId("timeline-lane-degradation")).toBeInTheDocument();
  });

  it("concurrency lane renders raw + weighted + hard_cap reference", async () => {
    const samples = [
      sample({
        id: 1,
        fetched_at: 1720000000000,
        concurrent_sessions: 2,
        weighted_concurrent_sessions: 3,
      }),
    ];
    render(
      <UsageTimeline
        dayUtc="2026-07-15"
        samples={samples}
        events={[]}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    const lane = screen.getByTestId("timeline-lane-concurrency");
    expect(lane.getAttribute("data-hard-cap")).toBe("16");
    expect(lane.getAttribute("data-raw-series")).toBe("present");
    expect(lane.getAttribute("data-weighted-series")).toBe("present");
  });

  it("requests lane renders in-window + limit + remaining", async () => {
    const samples = [
      sample({
        id: 1,
        fetched_at: 1720000000000,
        requests_in_window: 5,
        requests_limit: 1000,
        requests_remaining: 995,
      }),
    ];
    render(
      <UsageTimeline
        dayUtc="2026-07-15"
        samples={samples}
        events={[]}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    const lane = screen.getByTestId("timeline-lane-requests");
    expect(lane.getAttribute("data-in-window")).toBe("5");
    expect(lane.getAttribute("data-limit")).toBe("1000");
    expect(lane.getAttribute("data-remaining")).toBe("995");
  });

  it("token flow lane renders in/out/cached stacked", async () => {
    const samples = [
      sample({
        id: 1,
        fetched_at: 1720000000000,
        tokens_in: 100,
        tokens_out: 50,
        tokens_cached: 200,
      }),
    ];
    render(
      <UsageTimeline
        dayUtc="2026-07-15"
        samples={samples}
        events={[]}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    const lane = screen.getByTestId("timeline-lane-tokens");
    expect(lane.getAttribute("data-tokens-in")).toBe("100");
    expect(lane.getAttribute("data-tokens-out")).toBe("50");
    expect(lane.getAttribute("data-tokens-cached")).toBe("200");
  });

  it("cache hit rate lane renders line + 30-day average marker", async () => {
    const samples = [
      sample({
        id: 1,
        fetched_at: 1720000000000,
        tokens_in: 100,
        tokens_out: 50,
        tokens_cached: 200,
      }),
    ];
    const dailyRows = [
      daily({ day_utc: "2026-06-16", cache_hit_rate_avg: 0.4 }),
      daily({ day_utc: "2026-07-15", cache_hit_rate_avg: 0.8 }),
    ];
    render(
      <UsageTimeline
        dayUtc="2026-07-15"
        samples={samples}
        events={[]}
        daily30Day={dailyRows}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    const lane = screen.getByTestId("timeline-lane-cache-hit");
    // 30-day average marker = mean(0.4, 0.8) = 0.6
    expect(lane.getAttribute("data-30day-avg")).toBe("0.6");
  });

  it("degradation state lane renders priority + service_mode bands", async () => {
    const samples = [sample({ id: 1, fetched_at: 1720000000000 })];
    const events = [
      event({
        id: 1,
        onset_at: 1720000000000,
        transition: "onset",
        tuple_kind: "priority",
        priority_low: 1,
      }),
      event({
        id: 2,
        onset_at: 1720010000000,
        transition: "onset",
        tuple_kind: "service_mode",
        service_mode_current: "non-normal",
      }),
    ];
    render(
      <UsageTimeline
        dayUtc="2026-07-15"
        samples={samples}
        events={events}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    const lane = screen.getByTestId("timeline-lane-degradation");
    expect(lane.getAttribute("data-priority-bands")).toBe("1");
    expect(lane.getAttribute("data-service-mode-bands")).toBe("1");
  });

  it("ban-onset vertical lines span all lanes at event timestamps", async () => {
    const samples = [sample({ id: 1, fetched_at: 1720000000000 })];
    const events = [
      event({
        id: 1,
        onset_at: 1720005000000,
        transition: "onset",
        tuple_kind: "priority",
      }),
    ];
    render(
      <UsageTimeline
        dayUtc="2026-07-15"
        samples={samples}
        events={events}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    // Each lane carries the onset timestamps so the rendering can draw a
    // ReferenceLine at each x. We assert the lane knows about them.
    const concurrencyLane = screen.getByTestId("timeline-lane-concurrency");
    expect(concurrencyLane.getAttribute("data-ban-onsets")).toBe("[1720005000000]");
  });

  it("renders empty state when no samples for the day", async () => {
    render(
      <UsageTimeline
        dayUtc="2026-07-15"
        samples={[]}
        events={[]}
        daily30Day={null}
        loading={false}
        error={null}
      />,
    );
    await flushEffects();
    expect(screen.getByTestId("timeline-empty-state")).toBeInTheDocument();
  });
});
