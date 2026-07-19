// Integration test for ticket 01: usage_samples storage writer + API + tab.
// Verifies the thinnest vertical slice: schema → storage module → onChange
// hook → API route. Spawns the real proxy + a mock upstream serving /v1/usage,
// lets the usage poll cycle fire, then asserts the /dashboard/api/usage/samples
// endpoint returns coalesced rows.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

async function fetchSamples(proxy: ProxyHandle, date: string): Promise<UsageSampleRow[]> {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/samples?date=${date}`, {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as UsageSampleRow[];
}

describe("Integration: usage history (ticket 01)", () => {
  let upstream: CombinedMockHandle;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    upstream = startCombinedMock({ limit: 8, hardCap: 16, planName: "Code Pro" });
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${upstream.port}`,
      umansApiKey: "test-key",
      dashboardToken: "test-token",
      STAMP_CACHE_TTL_ENABLED: "false",
      WARMER_ENABLED: "false",
    });
    // USAGE_REFRESH_MS defaults to 100 in the proxy helper. Let a few polls fire.
    await sleep(600);
  });

  afterAll(async () => {
    await proxy.kill();
    await upstream.close();
    await sleep(100);
  });

  test("usage_samples table is created and rows are written from poll cycle", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const rows = await fetchSamples(proxy, today);
    expect(rows.length).toBeGreaterThan(0);
    const first = rows[0];
    expect(first.plan).toBe("Code Pro");
    expect(first.concurrency_hard_cap).toBe(16);
    expect(first.concurrency_soft_limit).toBe(8);
    expect(first.service_mode_current).toBe("normal");
    expect(first.priority_low).toBe(0);
    expect(first.fetched_at).toBeGreaterThan(0);
  });

  test("identical /v1/usage snapshots coalesce into a single sample row", async () => {
    // The combined mock returns an identical /v1/usage body on every poll.
    // After multiple polls, only one coalesced row should exist for this body.
    await sleep(500);
    const today = new Date().toISOString().slice(0, 10);
    const rows = await fetchSamples(proxy, today);
    expect(rows.length).toBe(1);
  });

  test("date=today alias returns today's samples", async () => {
    const todayRows = await fetchSamples(proxy, "today");
    const today = new Date().toISOString().slice(0, 10);
    const datedRows = await fetchSamples(proxy, today);
    expect(todayRows.length).toBe(datedRows.length);
  });

  test("changing /v1/usage response writes a new coalesced sample row", async () => {
    // Snapshot the current count, then mutate the upstream limit so the next
    // poll produces a different ambient body → must trigger a new write.
    const today = new Date().toISOString().slice(0, 10);
    const before = await fetchSamples(proxy, today);
    upstream.setLimit(12);
    await sleep(500);
    const after = await fetchSamples(proxy, today);
    expect(after.length).toBeGreaterThan(before.length);
    const newest = after[0];
    expect(newest.concurrency_soft_limit).toBe(12);
  });

  test("dashboard token auth is enforced on samples endpoint", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/samples?date=today`);
    expect(res.status).toBe(401);
    const authed = await fetch(`${proxy.baseUrl}/dashboard/api/usage/samples?date=today`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authed.ok).toBe(true);
  });
});
