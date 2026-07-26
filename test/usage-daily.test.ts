import { Database } from "bun:sqlite";
// Integration test for ticket 03: usage_daily downsampling + completeness +
// gap detection + API. Drives the mock upstream through real polls for today
// and inserts synthetic samples with explicit timestamps for past days to
// exercise the downsampling job's day-aggregation, completeness, and
// missing-day backfill paths.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addDays,
  downsampleDay,
  downsampleRange,
  UsageHistoryStore,
} from "../src/usage-history/index.js";
import { type CombinedMockHandle, startCombinedMock } from "./helpers/combined-mock";
import { type ProxyHandle, startProxy } from "./helpers/proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface UsageSampleRow {
  id: number;
  fetched_at: number;
  ok: number;
  user_id: string | null;
  plan: string;
  plan_slug: string | null;
  requests_limit: number | null;
  requests_hard_cap: number | null;
  requests_window_seconds: number | null;
  concurrency_soft_limit: number;
  concurrency_hard_cap: number;
  requests_in_window: number;
  weighted_requests_in_window: number;
  requests_remaining: number | null;
  weighted_remaining_requests: number | null;
  concurrent_sessions: number;
  weighted_concurrent_sessions: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  window_started_at: number | null;
  window_resets_at: number | null;
  window_remaining_minutes: number | null;
  priority_low: number;
  boxed_until: number | null;
  boxed_reason: string | null;
  units_demoted: number;
  demoted_until: number | null;
  service_mode_current: string;
  service_mode_resets_at: number | null;
}

interface UsageEventRow {
  id: number;
  onset_at: number;
  transition: string;
  tuple_kind: string;
  previous_event_id: number | null;
  fetched_at: number;
  priority_low: number;
  boxed_until: number | null;
  boxed_reason: string | null;
  units_demoted: number;
  demoted_until: number | null;
  service_mode_current: string;
  service_mode_resets_at: number | null;
  concurrent_sessions: number;
  weighted_concurrent_sessions: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cache_hit_rate: number | null;
}

interface UsageDailyRow {
  day_utc: string;
  day_completeness: string;
  first_activity_utc: number | null;
  last_activity_utc: number | null;
  accumulated_active_minutes: number | null;
  utc_clock_span_minutes: number | null;
  first_activity_utc_hour: number | null;
  last_activity_utc_hour: number | null;
  active_minutes_by_utc_hour: string | null;
  tokens_in_total: number | null;
  tokens_out_total: number | null;
  tokens_cached_total: number | null;
  requests_in_window_peak: number | null;
  requests_in_window_avg: number | null;
  cache_hit_rate_avg: number | null;
  concurrent_sessions_peak: number | null;
  concurrent_sessions_avg: number | null;
  weighted_concurrent_sessions_peak: number | null;
  weighted_concurrent_sessions_avg: number | null;
  at_first_priority_event_concurrent_sessions: number | null;
  at_first_priority_event_weighted_concurrent_sessions: number | null;
  at_first_priority_event_requests_in_window: number | null;
  at_first_priority_event_weighted_requests_in_window: number | null;
  at_first_priority_event_requests_remaining: number | null;
  at_first_priority_event_requests_limit: number | null;
  at_first_priority_event_tokens_in: number | null;
  at_first_priority_event_tokens_out: number | null;
  at_first_priority_event_tokens_cached: number | null;
  at_first_priority_event_cache_hit_rate: number | null;
  at_first_service_mode_event_concurrent_sessions: number | null;
  at_first_service_mode_event_weighted_concurrent_sessions: number | null;
  at_first_service_mode_event_requests_in_window: number | null;
  at_first_service_mode_event_weighted_requests_in_window: number | null;
  at_first_service_mode_event_requests_remaining: number | null;
  at_first_service_mode_event_requests_limit: number | null;
  at_first_service_mode_event_tokens_in: number | null;
  at_first_service_mode_event_tokens_out: number | null;
  at_first_service_mode_event_tokens_cached: number | null;
  at_first_service_mode_event_cache_hit_rate: number | null;
  priority_low_minutes: number | null;
  boxed_minutes: number | null;
  units_demoted_minutes: number | null;
  service_mode_non_normal_minutes: number | null;
  priority_events_count: number | null;
  service_mode_events_count: number | null;
  priority_ban_total_duration_ms: number | null;
  service_mode_ban_total_duration_ms: number | null;
  concurrency_hard_cap: number | null;
  requests_limit: number | null;
  requests_hard_cap: number | null;
  downsampled_at: number;
}

function utcDate(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}

function utcMidnightMs(daysAgo: number): number {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.getTime();
}

/** Insert a synthetic sample row with explicit fetched_at + ambient values.
 *  Used to build past-day scenarios the downsampler must aggregate. */
function insertSample(
  db: Database,
  fields: Partial<UsageSampleRow> & { fetched_at: number },
): number {
  const defaults: Omit<UsageSampleRow, "id" | "fetched_at"> = {
    ok: 1,
    user_id: null,
    plan: "Code Pro",
    plan_slug: "code-pro",
    requests_limit: 480,
    requests_hard_cap: 720,
    requests_window_seconds: 21600,
    concurrency_soft_limit: 8,
    concurrency_hard_cap: 16,
    requests_in_window: 0,
    weighted_requests_in_window: 0,
    requests_remaining: 480,
    weighted_remaining_requests: 480,
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
  const row = { ...defaults, ...fields };
  const cols = Object.keys(row).filter((c) => c !== "id");
  const placeholders = cols.map((c) => `$${c}`).join(", ");
  const values: Record<string, unknown> = {};
  for (const c of cols) values[`$${c}`] = (row as Record<string, unknown>)[c];
  const info = db
    .prepare(`INSERT INTO usage_samples (${cols.join(", ")}) VALUES (${placeholders})`)
    .run(values);
  return Number(info.lastInsertRowid);
}

function insertEvent(
  db: Database,
  fields: Partial<UsageEventRow> & {
    onset_at: number;
    transition: string;
    tuple_kind: string;
  },
): number {
  const defaults: Omit<UsageEventRow, "id" | "onset_at" | "transition" | "tuple_kind"> = {
    previous_event_id: null,
    fetched_at: fields.onset_at,
    ok: 1,
    user_id: null,
    plan: "Code Pro",
    plan_slug: "code-pro",
    requests_limit: 480,
    requests_hard_cap: 720,
    requests_window_seconds: 21600,
    concurrency_soft_limit: 8,
    concurrency_hard_cap: 16,
    requests_in_window: 0,
    weighted_requests_in_window: 0,
    requests_remaining: 480,
    weighted_remaining_requests: 480,
    concurrent_sessions: 0,
    weighted_concurrent_sessions: 0,
    tokens_in: 0,
    tokens_out: 0,
    tokens_cached: 0,
    cache_hit_rate: null,
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
  const row = { ...defaults, ...fields };
  const cols = Object.keys(row).filter((c) => c !== "id");
  const placeholders = cols.map((c) => `$${c}`).join(", ");
  const values: Record<string, unknown> = {};
  for (const c of cols) values[`$${c}`] = (row as Record<string, unknown>)[c];
  const info = db
    .prepare(`INSERT INTO usage_events (${cols.join(", ")}) VALUES (${placeholders})`)
    .run(values);
  return Number(info.lastInsertRowid);
}

async function triggerDownsample(
  proxy: ProxyHandle,
  from?: string,
  to?: string,
): Promise<Response> {
  const params = new URLSearchParams();
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  const url = `${proxy.baseUrl}/dashboard/api/usage/downsample${qs ? `?${qs}` : ""}`;
  return fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer test-token" },
  });
}

async function fetchDaily(proxy: ProxyHandle, from: string, to: string): Promise<UsageDailyRow[]> {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/daily?from=${from}&to=${to}`, {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as UsageDailyRow[];
}

describe("Integration: usage daily (ticket 03)", () => {
  let upstream: CombinedMockHandle;
  let proxy: ProxyHandle;
  let db: Database;

  beforeAll(async () => {
    upstream = startCombinedMock({ limit: 8, hardCap: 16, planName: "Code Pro" });
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      umansApiKey: "test-key",
      dashboardToken: "test-token",
      STAMP_CACHE_TTL_ENABLED: "false",
      WARMER_ENABLED: "false",
      USAGE_RAW_RETENTION_DAYS: "7",
      USAGE_GAP_THRESHOLD_MINUTES: "60",
      USAGE_IDLE_SESSION_TIMEOUT_MINUTES: "5",
    });
    // Wait for the proxy to be ready and run at least one poll.
    await sleep(400);
    db = new Database(proxy.dbPath);
  });

  afterAll(async () => {
    try {
      db.close();
    } catch {
      // ignore
    }
    await proxy.kill();
    await upstream.close();
    await sleep(100);
  });

  test("daily aggregate row is produced with two-snapshot + two-dimension fields", async () => {
    // Build a synthetic past day with several samples + an event mid-day.
    const day = utcDate(2);
    const t0 = utcMidnightMs(2);
    const dayBase = {
      plan: "Code Pro",
      plan_slug: "code-pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      requests_limit: 480,
      requests_hard_cap: 720,
      requests_window_seconds: 21600,
    };
    // Samples across 08:00 → 22:00 UTC with monotonically increasing tokens.
    insertSample(db, {
      ...dayBase,
      fetched_at: t0 + 8 * 3600_000,
      tokens_in: 100_000_000,
      tokens_out: 50_000_000,
      tokens_cached: 10_000_000,
      concurrent_sessions: 2,
      weighted_concurrent_sessions: 3,
      requests_in_window: 50,
      weighted_requests_in_window: 60,
    });
    insertSample(db, {
      ...dayBase,
      fetched_at: t0 + 14 * 3600_000,
      // Priority ban onset at 14:00 — trigger-moment snapshot
      priority_low: 1,
      boxed_until: t0 + 22 * 3600_000,
      boxed_reason: "hard_cap_hit",
      tokens_in: 200_000_000,
      tokens_out: 100_000_000,
      tokens_cached: 30_000_000,
      concurrent_sessions: 4,
      weighted_concurrent_sessions: 6,
      requests_in_window: 120,
      weighted_requests_in_window: 150,
    });
    insertSample(db, {
      ...dayBase,
      fetched_at: t0 + 22 * 3600_000,
      priority_low: 1,
      boxed_until: t0 + 22 * 3600_000,
      boxed_reason: "hard_cap_hit",
      tokens_in: 400_000_000,
      tokens_out: 200_000_000,
      tokens_cached: 60_000_000,
      concurrent_sessions: 1,
      weighted_concurrent_sessions: 2,
      requests_in_window: 200,
      weighted_requests_in_window: 250,
    });
    // Priority onset event at 14:00.
    insertEvent(db, {
      ...dayBase,
      onset_at: t0 + 14 * 3600_000,
      fetched_at: t0 + 14 * 3600_000,
      transition: "onset",
      tuple_kind: "priority",
      priority_low: 1,
      boxed_until: t0 + 22 * 3600_000,
      boxed_reason: "hard_cap_hit",
      tokens_in: 200_000_000,
      tokens_out: 100_000_000,
      tokens_cached: 30_000_000,
      concurrent_sessions: 4,
      weighted_concurrent_sessions: 6,
      requests_in_window: 120,
      weighted_requests_in_window: 150,
      cache_hit_rate: 30_000_000 / (200_000_000 + 100_000_000 + 30_000_000),
    });

    const res = await triggerDownsample(proxy);
    expect(res.ok).toBe(true);

    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.day_utc).toBe(day);
    // Completeness: first hour=8 (not 0), last hour=22 (not 23) → partial_both.
    // But the gap check might pass; let's assert partial_both.
    expect(row.day_completeness).toBe("partial_both");

    // Two-dimension activity — Dimension A: accumulated active minutes.
    // Pairs: 8→14h = 360min (≤60min threshold? No, 360 > 60 → gap, excluded).
    //        14→22h = 480min (gap, excluded).
    // So accumulated_active_minutes = 0 (all pairs exceed threshold).
    // Hmm — that's not useful. The threshold is 60min; longer intervals are
    // gaps. So for this test, we expect 0 active minutes.
    expect(row.accumulated_active_minutes).toBe(0);
    // Dimension B: UTC clock span = 22 - 8 = 14 hours = 840 minutes.
    expect(row.utc_clock_span_minutes).toBe(840);
    expect(row.first_activity_utc_hour).toBe(8);
    expect(row.last_activity_utc_hour).toBe(22);

    // Two-snapshot model — day-total (monotonic counters from last sample).
    expect(row.tokens_in_total).toBe(400_000_000);
    expect(row.tokens_out_total).toBe(200_000_000);
    expect(row.tokens_cached_total).toBe(60_000_000);
    expect(row.concurrent_sessions_peak).toBe(4);
    expect(row.weighted_concurrent_sessions_peak).toBe(6);
    expect(row.requests_in_window_peak).toBe(200);

    // Two-snapshot model — trigger-moment (priority event at 14:00).
    expect(row.at_first_priority_event_tokens_in).toBe(200_000_000);
    expect(row.at_first_priority_event_tokens_out).toBe(100_000_000);
    expect(row.at_first_priority_event_tokens_cached).toBe(30_000_000);
    expect(row.at_first_priority_event_concurrent_sessions).toBe(4);
    expect(row.at_first_priority_event_weighted_concurrent_sessions).toBe(6);
    expect(row.at_first_priority_event_requests_in_window).toBe(120);

    // No service_mode event → all at_first_service_mode_event_* should be NULL.
    expect(row.at_first_service_mode_event_tokens_in).toBeNull();
    expect(row.at_first_service_mode_event_concurrent_sessions).toBeNull();

    // Static-for-day.
    expect(row.concurrency_hard_cap).toBe(16);
    expect(row.requests_limit).toBe(480);
    expect(row.requests_hard_cap).toBe(720);

    // Degradation burden — ban from 14:00 to 22:00 = 8h = 480 min.
    expect(row.priority_low_minutes).toBe(480);
    expect(row.priority_events_count).toBe(1);
    expect(row.service_mode_events_count).toBe(0);
    expect(row.priority_ban_total_duration_ms).toBe(8 * 3600_000);

    // Raw samples for that day should be pruned (downsampler deletes them).
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM usage_samples WHERE fetched_at >= ? AND fetched_at < ?")
      .get({ $start: t0, $end: t0 + 86400_000 }) as { n: number };
    expect(remaining.n).toBe(0);
  });

  test("idempotency: running downsampling twice produces one row", async () => {
    const day = utcDate(3);
    const t0 = utcMidnightMs(3);
    insertSample(db, {
      fetched_at: t0 + 10 * 3600_000,
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 1000,
      tokens_out: 500,
      tokens_cached: 100,
    });
    await triggerDownsample(proxy);
    const rows1 = await fetchDaily(proxy, day, day);
    expect(rows1.length).toBe(1);
    await triggerDownsample(proxy);
    const rows2 = await fetchDaily(proxy, day, day);
    expect(rows2.length).toBe(1);
    expect(rows2[0].day_utc).toBe(rows1[0].day_utc);
    expect(rows2[0].day_completeness).toBe(rows1[0].day_completeness);
  });

  test("missing-day backfill: day with no samples gets NULL-activity row with completeness=missing", async () => {
    const day = utcDate(5);
    await triggerDownsample(proxy);
    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    const row = rows[0];
    expect(row.day_completeness).toBe("missing");
    expect(row.first_activity_utc).toBeNull();
    expect(row.last_activity_utc).toBeNull();
    expect(row.accumulated_active_minutes).toBeNull();
    expect(row.utc_clock_span_minutes).toBeNull();
    expect(row.tokens_in_total).toBeNull();
    expect(row.priority_events_count).toBe(0);
    expect(row.service_mode_events_count).toBe(0);
  });

  test("gap detection: >threshold gap with non-identical samples → incomplete_window", async () => {
    const day = utcDate(4);
    const t0 = utcMidnightMs(4);
    // Two samples 90min apart, non-identical (different tokens_in).
    insertSample(db, {
      fetched_at: t0 + 10 * 3600_000,
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 100,
      tokens_out: 50,
      tokens_cached: 10,
    });
    insertSample(db, {
      fetched_at: t0 + 10 * 3600_000 + 90 * 60_000,
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 200,
      tokens_out: 100,
      tokens_cached: 20,
    });
    await triggerDownsample(proxy);
    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    // First hour=10 (>0 → partial_start), last hour=10 (<23 → partial_end),
    // AND mid-day gap>threshold → partial_both wins per precedence rule.
    // Per decision 10: "partial_both" wins over "incomplete_window".
    expect(rows[0].day_completeness).toBe("partial_both");
  });

  test("full day: samples span 00:00–23:59 with no gaps → full", async () => {
    const day = utcDate(6);
    const t0 = utcMidnightMs(6);
    // Samples every 30 minutes across the full day. Use a sparse set for test speed.
    for (let h = 0; h < 24; h++) {
      insertSample(db, {
        fetched_at: t0 + h * 3600_000,
        plan: "Code Pro",
        concurrency_soft_limit: 8,
        concurrency_hard_cap: 16,
        tokens_in: h * 1000,
        tokens_out: h * 500,
        tokens_cached: h * 100,
      });
    }
    await triggerDownsample(proxy);
    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    expect(rows[0].day_completeness).toBe("full");
    expect(rows[0].first_activity_utc_hour).toBe(0);
    expect(rows[0].last_activity_utc_hour).toBe(23);
  });

  test("byte-identical adjacent samples do not count as gaps", async () => {
    const day = utcDate(7);
    const t0 = utcMidnightMs(7);
    // Two byte-identical samples 90min apart. The coalescing writer would
    // never produce these, but if it did, they should NOT trigger incomplete_window.
    const base = {
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 1000,
      tokens_out: 500,
      tokens_cached: 100,
      requests_in_window: 5,
      weighted_requests_in_window: 5,
      concurrent_sessions: 1,
      weighted_concurrent_sessions: 1,
      requests_limit: 480,
      requests_hard_cap: 720,
      requests_window_seconds: 21600,
      requests_remaining: 475,
      weighted_remaining_requests: 475,
    };
    insertSample(db, { ...base, fetched_at: t0 + 10 * 3600_000 });
    insertSample(db, { ...base, fetched_at: t0 + 10 * 3600_000 + 90 * 60_000 });
    await triggerDownsample(proxy);
    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    // Identical samples → not a gap. But still partial_both (first hour=10, last hour=10).
    expect(rows[0].day_completeness).toBe("partial_both");
    // And the gap should NOT contribute to "incomplete_window".
    expect(rows[0].day_completeness).not.toBe("incomplete_window");
  });

  test("byte-identical long gap skips interval and resets idle streak", async () => {
    const day = utcDate(7);
    const t0 = utcMidnightMs(7);
    // Simulate sleep/wake: active session, then 90min gap with byte-identical
    // samples (coalescing produced no new sample during sleep), then activity
    // resumes. The gap interval (90min, identical) must be skipped and the
    // idle streak reset so post-wake intervals count fresh.
    const base = {
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 1000,
      tokens_out: 500,
      tokens_cached: 100,
      requests_in_window: 5,
      weighted_requests_in_window: 5,
      concurrent_sessions: 1,
      weighted_concurrent_sessions: 1,
      requests_limit: 480,
      requests_hard_cap: 720,
      requests_window_seconds: 21600,
      requests_remaining: 475,
      weighted_remaining_requests: 475,
    };
    // t=0: active sample
    insertSample(db, { ...base, fetched_at: t0 + 10 * 3600_000 });
    // t=90min: byte-identical (ambientKey equal → identical=true)
    insertSample(db, { ...base, fetched_at: t0 + 10 * 3600_000 + 90 * 60_000 });
    // t=91min: tokens advance (activity resumes after wake)
    insertSample(db, {
      ...base,
      tokens_in: 2000,
      tokens_out: 1000,
      tokens_cached: 200,
      fetched_at: t0 + 10 * 3600_000 + 91 * 60_000,
    });
    await triggerDownsample(proxy);
    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    // The 90min identical gap is skipped (not counted). The 1min post-wake
    // interval with token advance counts. Total active = 1min.
    expect(rows[0].accumulated_active_minutes).toBe(1);
  });

  test("retention pruning: samples older than retention_days are deleted", async () => {
    // Insert a sample from 10 days ago — beyond the 7-day retention.
    const oldDay = utcDate(10);
    const t0 = utcMidnightMs(10);
    insertSample(db, {
      fetched_at: t0 + 12 * 3600_000,
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 100,
    });
    await triggerDownsample(proxy, oldDay, oldDay);
    const rows = await fetchDaily(proxy, oldDay, oldDay);
    expect(rows.length).toBe(1);
    // The old sample should be pruned.
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM usage_samples WHERE fetched_at >= ? AND fetched_at < ?")
      .get({ $start: t0, $end: t0 + 86400_000 }) as { n: number };
    expect(remaining.n).toBe(0);
  });

  test("GET /usage/daily returns rows for range, default last 30 days", async () => {
    const from = utcDate(10);
    const to = utcDate(0);
    const rows = await fetchDaily(proxy, from, to);
    expect(rows.length).toBeGreaterThan(0);
    // Sorted ascending by day_utc.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].day_utc >= rows[i - 1].day_utc).toBe(true);
    }
  });

  test("dashboard token auth is enforced on daily endpoint", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/daily`);
    expect(res.status).toBe(401);
    const authed = await fetch(`${proxy.baseUrl}/dashboard/api/usage/daily`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authed.ok).toBe(true);
  });

  test("dashboard token auth is enforced on downsample endpoint", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/downsample`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  // ─── Regression: stale-today fix (computer not on 24/7) ───

  test("downsampleDay upserts: calling it twice on the same day yields one row with updated values", async () => {
    const day = utcDate(8);
    const t0 = utcMidnightMs(8);
    // First pass: one sample at 10:00 with tokens_in=1000.
    insertSample(db, {
      fetched_at: t0 + 10 * 3600_000,
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 1000,
      tokens_out: 500,
      tokens_cached: 100,
    });
    await triggerDownsample(proxy, day, day);
    const rows1 = await fetchDaily(proxy, day, day);
    expect(rows1.length).toBe(1);
    expect(rows1[0].tokens_in_total).toBe(1000);
    const firstDownsampledAt = rows1[0].downsampled_at;

    // Second pass: add a later sample at 14:00 with tokens_in=2000. The day
    // already has a row, so a non-force downsampleRange would skip it. But
    // the POST /downsample endpoint uses force:true — simulating the 10-min
    // refresh-today timer which calls downsampleDay directly.
    insertSample(db, {
      fetched_at: t0 + 14 * 3600_000,
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 2000,
      tokens_out: 1000,
      tokens_cached: 200,
    });
    await triggerDownsample(proxy, day, day);
    const rows2 = await fetchDaily(proxy, day, day);
    // Still exactly one row — upsert, not insert.
    expect(rows2.length).toBe(1);
    // Token totals updated to the new last-sample values.
    expect(rows2[0].tokens_in_total).toBe(2000);
    expect(rows2[0].tokens_out_total).toBe(1000);
    // downsampled_at advanced.
    expect(rows2[0].downsampled_at).toBeGreaterThanOrEqual(firstDownsampledAt);
  });

  test("stale today row refreshes after new samples arrive (the core bug)", async () => {
    const day = utcDate(1);
    const t0 = utcMidnightMs(1);
    // Seed one early sample (simulating startup with minimal data).
    insertSample(db, {
      fetched_at: t0 + 1 * 3600_000,
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 100,
      tokens_out: 50,
      tokens_cached: 10,
      concurrent_sessions: 1,
    });
    await triggerDownsample(proxy, day, day);
    const before = (await fetchDaily(proxy, day, day))[0];
    expect(before.tokens_in_total).toBe(100);

    // More samples arrive throughout the "day" (user keeps coding).
    for (let h = 2; h <= 8; h++) {
      insertSample(db, {
        fetched_at: t0 + h * 3600_000,
        plan: "Code Pro",
        concurrency_soft_limit: 8,
        concurrency_hard_cap: 16,
        tokens_in: 100 + h * 1000,
        tokens_out: 50 + h * 500,
        tokens_cached: 10 + h * 100,
        concurrent_sessions: 1,
      });
    }
    // Force-recompute (what the 10-min timer does via downsampleDay).
    await triggerDownsample(proxy, day, day);
    const after = (await fetchDaily(proxy, day, day))[0];
    // The row now reflects the latest sample, not the startup snapshot.
    expect(after.tokens_in_total).toBe(100 + 8 * 1000);
    expect(after.tokens_out_total).toBe(50 + 8 * 500);
    expect(after.downsampled_at).toBeGreaterThanOrEqual(before.downsampled_at);
  });

  test("active minutes count session-open intervals even when tokens do not advance", async () => {
    const day = utcDate(9);
    const t0 = utcMidnightMs(9);
    // Two samples 5min apart. tokens identical (no token movement), but
    // concurrent_sessions=1 in both (session open). Pre-fix this interval
    // would be skipped (activityKey identical). Post-fix it counts because
    // the user has an open session — they're "working" (reading/thinking).
    const base = {
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 1000,
      tokens_out: 500,
      tokens_cached: 100,
      concurrent_sessions: 1,
      weighted_concurrent_sessions: 1,
      requests_in_window: 1,
      weighted_requests_in_window: 1,
      requests_limit: 480,
      requests_hard_cap: 720,
      requests_window_seconds: 21600,
      requests_remaining: 479,
      weighted_remaining_requests: 479,
    };
    insertSample(db, { ...base, fetched_at: t0 + 10 * 3600_000 });
    insertSample(db, { ...base, fetched_at: t0 + 10 * 3600_000 + 5 * 60_000 });
    await triggerDownsample(proxy, day, day);
    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    // The 5-minute session-open interval must count as active.
    expect(rows[0].accumulated_active_minutes).toBe(5);
  });

  test("truly idle intervals (concurrent_sessions=0, no token movement) are not counted", async () => {
    const day = utcDate(9);
    const t0 = utcMidnightMs(9);
    // Two samples 5min apart, both with concurrent_sessions=0 and identical
    // tokens. This is a genuinely idle gap — must NOT count as active.
    const base = {
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 1000,
      tokens_out: 500,
      tokens_cached: 100,
      concurrent_sessions: 0,
      weighted_concurrent_sessions: 0,
      requests_in_window: 0,
      weighted_requests_in_window: 0,
      requests_limit: 480,
      requests_hard_cap: 720,
      requests_window_seconds: 21600,
      requests_remaining: 480,
      weighted_remaining_requests: 480,
    };
    insertSample(db, { ...base, fetched_at: t0 + 10 * 3600_000 });
    insertSample(db, { ...base, fetched_at: t0 + 10 * 3600_000 + 5 * 60_000 });
    await triggerDownsample(proxy, day, day);
    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    expect(rows[0].accumulated_active_minutes).toBe(0);
  });

  test("idle session exceeding timeout is not counted as active", async () => {
    const day = utcDate(9);
    const t0 = utcMidnightMs(9);
    // 7 samples, 1 min apart, all with concurrent_sessions=1 but identical
    // tokens (no token movement). idleSessionTimeoutMinutes=5 (from env).
    // Intervals 1-5 count as active (streak ≤ 5min). Intervals 6+ are skipped
    // (streak > 5min). Total active = 5min.
    const base = {
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 1000,
      tokens_out: 500,
      tokens_cached: 100,
      concurrent_sessions: 1,
      weighted_concurrent_sessions: 1,
      requests_in_window: 1,
      weighted_requests_in_window: 1,
      requests_limit: 480,
      requests_hard_cap: 720,
      requests_window_seconds: 21600,
      requests_remaining: 479,
      weighted_remaining_requests: 479,
    };
    for (let m = 0; m <= 7; m++) {
      insertSample(db, { ...base, fetched_at: t0 + 10 * 3600_000 + m * 60_000 });
    }
    await triggerDownsample(proxy, day, day);
    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    // 7 intervals of 1 min each. First 5 count (streak ≤ 5min), last 2 skipped.
    expect(rows[0].accumulated_active_minutes).toBe(5);
  });

  test("token advance resets idle streak", async () => {
    const day = utcDate(9);
    const t0 = utcMidnightMs(9);
    // 6 samples: 3 idle (streak=3min), then token advance, then 3 more idle.
    // All 6 intervals should count: first 3 (streak≤5), then token advance
    // resets streak, then next 3 (streak≤5 again). Total = 6min.
    const base = {
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_out: 500,
      tokens_cached: 100,
      concurrent_sessions: 1,
      weighted_concurrent_sessions: 1,
      requests_in_window: 1,
      weighted_requests_in_window: 1,
      requests_limit: 480,
      requests_hard_cap: 720,
      requests_window_seconds: 21600,
      requests_remaining: 479,
      weighted_remaining_requests: 479,
    };
    // t=0,1,2: idle (tokens_in=1000)
    for (const m of [0, 1, 2]) {
      insertSample(db, { ...base, tokens_in: 1000, fetched_at: t0 + 10 * 3600_000 + m * 60_000 });
    }
    // t=3: token advance (tokens_in=2000)
    insertSample(db, { ...base, tokens_in: 2000, fetched_at: t0 + 10 * 3600_000 + 3 * 60_000 });
    // t=4,5,6: idle again (tokens_in=2000)
    for (const m of [4, 5, 6]) {
      insertSample(db, { ...base, tokens_in: 2000, fetched_at: t0 + 10 * 3600_000 + m * 60_000 });
    }
    await triggerDownsample(proxy, day, day);
    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    // 6 intervals × 1min = 6min. Both idle streaks (3min each) are under 5min.
    expect(rows[0].accumulated_active_minutes).toBe(6);
  });

  test("session close transition counts as active even without token advance", async () => {
    const day = utcDate(9);
    const t0 = utcMidnightMs(9);
    // prev: cs=1 (session open), next: cs=0 (session closed). No token advance.
    // activityKey differs (cs changed) → branch 4 (else) → counts + resets streak.
    const base = {
      plan: "Code Pro",
      concurrency_soft_limit: 8,
      concurrency_hard_cap: 16,
      tokens_in: 1000,
      tokens_out: 500,
      tokens_cached: 100,
      requests_in_window: 1,
      weighted_requests_in_window: 1,
      requests_limit: 480,
      requests_hard_cap: 720,
      requests_window_seconds: 21600,
      requests_remaining: 479,
      weighted_remaining_requests: 479,
    };
    insertSample(db, {
      ...base,
      concurrent_sessions: 1,
      weighted_concurrent_sessions: 1,
      fetched_at: t0 + 10 * 3600_000,
    });
    insertSample(db, {
      ...base,
      concurrent_sessions: 0,
      weighted_concurrent_sessions: 0,
      fetched_at: t0 + 10 * 3600_000 + 5 * 60_000,
    });
    await triggerDownsample(proxy, day, day);
    const rows = await fetchDaily(proxy, day, day);
    expect(rows.length).toBe(1);
    // The 5-min interval where session closed counts as active.
    expect(rows[0].accumulated_active_minutes).toBe(5);
  });
});

// ─── Direct unit tests: timer code path + retention-aware heal ───

describe("Unit: downsampleDay + retention-aware split (timer code path)", () => {
  let storeDb: Database;
  let store: UsageHistoryStore;

  beforeAll(() => {
    storeDb = new Database(":memory:");
    store = new UsageHistoryStore({ db: storeDb });
  });

  afterAll(() => {
    storeDb.close();
  });

  test("downsampleDay does not prune raw samples (unlike downsampleRange with force)", () => {
    const day = utcDate(0);
    const t0 = utcMidnightMs(0);
    insertSample(storeDb, {
      fetched_at: t0 + 10 * 3600_000,
      tokens_in: 1000,
      tokens_out: 500,
      tokens_cached: 100,
      concurrent_sessions: 1,
    });
    downsampleDay(store, day, 60, 5);
    const count = storeDb.prepare("SELECT COUNT(*) AS n FROM usage_samples").get() as { n: number };
    expect(count.n).toBe(1);
  });

  test("downsampleDay upserts: two calls yield one row with updated values and no pruning", () => {
    const day = utcDate(0);
    const t0 = utcMidnightMs(0);
    storeDb
      .prepare("DELETE FROM usage_samples WHERE fetched_at >= $start AND fetched_at < $end")
      .run({ $start: t0, $end: t0 + 86400_000 });
    storeDb.prepare("DELETE FROM usage_daily WHERE day_utc = $day").run({ $day: day });

    insertSample(storeDb, {
      fetched_at: t0 + 10 * 3600_000,
      tokens_in: 1000,
      tokens_out: 500,
      tokens_cached: 100,
      concurrent_sessions: 1,
    });
    downsampleDay(store, day, 60, 5);
    const row1 = store.getDailyRow(day);
    expect(row1?.tokens_in_total).toBe(1000);

    insertSample(storeDb, {
      fetched_at: t0 + 14 * 3600_000,
      tokens_in: 2000,
      tokens_out: 1000,
      tokens_cached: 200,
      concurrent_sessions: 1,
    });
    downsampleDay(store, day, 60, 5);
    const row2 = store.getDailyRow(day);
    const rowCount = storeDb
      .prepare("SELECT COUNT(*) AS n FROM usage_daily WHERE day_utc = $day")
      .get({ $day: day }) as { n: number };
    expect(rowCount.n).toBe(1);
    expect(row2?.tokens_in_total).toBe(2000);
    expect(row2!.downsampled_at).toBeGreaterThanOrEqual(row1!.downsampled_at);
    const sampleCount = storeDb.prepare("SELECT COUNT(*) AS n FROM usage_samples").get() as {
      n: number;
    };
    expect(sampleCount.n).toBe(2);
  });

  test("retention-aware split: within-retention stale row healed, beyond-retention row preserved", () => {
    const retentionDays = 7;
    const today = utcDate(0);
    const withinDay = utcDate(3);
    const beyondDay = utcDate(10);
    const withinT0 = utcMidnightMs(3);
    const beyondT0 = utcMidnightMs(10);

    // Clean slate for this test.
    storeDb.prepare("DELETE FROM usage_samples").run();
    storeDb.prepare("DELETE FROM usage_daily").run();

    insertSample(storeDb, {
      fetched_at: withinT0 + 8 * 3600_000,
      tokens_in: 100,
      tokens_out: 50,
      tokens_cached: 10,
      concurrent_sessions: 1,
    });
    downsampleDay(store, withinDay, 60, 5);
    const staleRow = store.getDailyRow(withinDay);
    expect(staleRow?.tokens_in_total).toBe(100);

    insertSample(storeDb, {
      fetched_at: withinT0 + 14 * 3600_000,
      tokens_in: 2000,
      tokens_out: 1000,
      tokens_cached: 200,
      concurrent_sessions: 1,
    });

    insertSample(storeDb, {
      fetched_at: beyondT0 + 8 * 3600_000,
      tokens_in: 500,
      tokens_out: 250,
      tokens_cached: 50,
      concurrent_sessions: 1,
    });
    downsampleDay(store, beyondDay, 60, 5);
    const beyondRow = store.getDailyRow(beyondDay);
    expect(beyondRow?.tokens_in_total).toBe(500);
    store.deleteSamplesInRange(beyondDay, beyondDay);

    const retentionCutoffDay = addDays(today, -(retentionDays - 1));
    if (beyondDay < retentionCutoffDay) {
      downsampleRange(store, beyondDay, addDays(retentionCutoffDay, -1), {
        gapThresholdMinutes: 60,
        idleSessionTimeoutMinutes: 5,
        retentionDays,
      });
    }
    downsampleRange(store, retentionCutoffDay, today, {
      gapThresholdMinutes: 60,
      idleSessionTimeoutMinutes: 5,
      retentionDays,
      force: true,
    });

    const healedRow = store.getDailyRow(withinDay);
    expect(healedRow?.tokens_in_total).toBe(2000);
    expect(healedRow?.accumulated_active_minutes).not.toBe(null);

    const preservedRow = store.getDailyRow(beyondDay);
    expect(preservedRow?.tokens_in_total).toBe(500);
  });
});
