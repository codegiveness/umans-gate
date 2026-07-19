// Integration test for ticket 02: usage_events storage + tuple detector + API.
// Drives the mock upstream through priority/service_mode transitions and asserts
// event rows appear via the /dashboard/api/usage/events endpoint with correct
// transition classifications, previous_event_id links, and ambient context.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CombinedMockHandle, startCombinedMock } from "./helpers/combined-mock";
import { type ProxyHandle, startProxy } from "./helpers/proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface UsageEventRow {
  id: number;
  onset_at: number;
  transition: string;
  tuple_kind: string;
  previous_event_id: number | null;
  cache_hit_rate: number | null;
  priority_low: number;
  boxed_until: number | null;
  boxed_reason: string | null;
  units_demoted: number;
  demoted_until: number | null;
  service_mode_current: string;
  service_mode_resets_at: number | null;
  fetched_at: number;
  concurrent_sessions: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
}

async function fetchEvents(proxy: ProxyHandle, date: string): Promise<UsageEventRow[]> {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/events?date=${date}`, {
    headers: { Authorization: "Bearer test-token" },
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as UsageEventRow[];
}

describe("Integration: usage events (ticket 02)", () => {
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
    // Let a few polls fire on the default (normal, no ban) state so the
    // detector seeds its last-seen tuple state silently.
    await sleep(500);
  });

  afterAll(async () => {
    await proxy.kill();
    await upstream.close();
    await sleep(100);
  });

  test("no events fire for the initial all-clear polls", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const events = await fetchEvents(proxy, today);
    expect(events.length).toBe(0);
  });

  test("priority-low onset produces an onset event with full ambient context", async () => {
    const boxedUntil = Date.now() + 60_000;
    upstream.setPriority({ low: true, boxedUntil, reason: "hard_cap_hit" });
    upstream.setTokens({ tokensIn: 1000, tokensOut: 500, tokensCached: 500 });
    await sleep(500);
    const today = new Date().toISOString().slice(0, 10);
    const events = await fetchEvents(proxy, today);
    expect(events.length).toBeGreaterThanOrEqual(1);
    const onset = events[0];
    expect(onset.transition).toBe("onset");
    expect(onset.tuple_kind).toBe("priority");
    expect(onset.previous_event_id).toBeNull();
    expect(onset.priority_low).toBe(1);
    expect(onset.boxed_until).toBe(boxedUntil);
    expect(onset.boxed_reason).toBe("hard_cap_hit");
    // Ambient context carried into the event row.
    expect(onset.concurrent_sessions).toBe(0);
    expect(onset.tokens_in).toBe(1000);
    expect(onset.tokens_out).toBe(500);
    expect(onset.tokens_cached).toBe(500);
    // cacheHitRate = 500 / (1000 + 500 + 500) = 0.25
    expect(onset.cache_hit_rate).toBeCloseTo(0.25, 5);
  });

  test("priority-low resolved produces a resolved event linked to the onset", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const beforeEvents = await fetchEvents(proxy, today);
    const onsetId = beforeEvents[0].id;

    upstream.setPriority({ low: false, boxedUntil: null, reason: null });
    await sleep(500);
    const events = await fetchEvents(proxy, today);
    expect(events.length).toBeGreaterThanOrEqual(2);
    const resolved = events[0];
    expect(resolved.transition).toBe("resolved");
    expect(resolved.tuple_kind).toBe("priority");
    expect(resolved.previous_event_id).toBe(onsetId);
    expect(resolved.priority_low).toBe(0);
  });

  test("service_mode onset produces a separate service_mode event", async () => {
    upstream.setServiceMode({ current: "degraded", resetsAt: Date.now() + 3_600_000 });
    await sleep(500);
    const today = new Date().toISOString().slice(0, 10);
    const events = await fetchEvents(proxy, today);
    const smEvents = events.filter((e) => e.tuple_kind === "service_mode");
    expect(smEvents.length).toBeGreaterThanOrEqual(1);
    const onset = smEvents[0];
    expect(onset.transition).toBe("onset");
    expect(onset.service_mode_current).toBe("degraded");
    expect(onset.service_mode_resets_at).not.toBeNull();
    expect(onset.previous_event_id).toBeNull();
  });

  test("service_mode morph produces a morph event linked to its onset", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const beforeEvents = await fetchEvents(proxy, today);
    const smOnset = beforeEvents.find(
      (e) => e.tuple_kind === "service_mode" && e.transition === "onset",
    );
    expect(smOnset).toBeDefined();

    upstream.setServiceMode({
      current: "severe",
      resetsAt: Date.now() + 7_200_000,
    });
    await sleep(500);
    const events = await fetchEvents(proxy, today);
    const morphs = events.filter(
      (e) => e.transition === "morph" && e.tuple_kind === "service_mode",
    );
    expect(morphs.length).toBeGreaterThanOrEqual(1);
    expect(morphs[0].previous_event_id).toBe(smOnset?.id ?? null);
    expect(morphs[0].service_mode_current).toBe("severe");
  });

  test("non-transitioning polls do not produce new events", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const before = (await fetchEvents(proxy, today)).length;
    // Mutate an ambient field that is NOT part of either tuple (tokens_in only).
    upstream.setTokens({ tokensIn: 5000 });
    await sleep(500);
    const after = (await fetchEvents(proxy, today)).length;
    expect(after).toBe(before);
  });

  test("date=today alias returns the same events as the explicit date", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const byAlias = await fetchEvents(proxy, "today");
    const byDate = await fetchEvents(proxy, today);
    expect(byAlias.length).toBe(byDate.length);
  });

  test("dashboard token auth is enforced on events endpoint", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/events?date=today`);
    expect(res.status).toBe(401);
    const authed = await fetch(`${proxy.baseUrl}/dashboard/api/usage/events?date=today`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(authed.ok).toBe(true);
  });
});
