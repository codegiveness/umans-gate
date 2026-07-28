import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  addDays,
  downsampleDay,
  downsampleRange,
  UsageHistoryStore,
} from "../../src/usage-history/index.js";

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

/** Insert a synthetic sample row with explicit fetched_at + ambient values. */
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
