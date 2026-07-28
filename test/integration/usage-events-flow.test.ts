import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CombinedMockHandle, startCombinedMock } from "../helpers/combined-mock";
import { type InProcessProxyHandle, startInProcessProxy } from "../helpers/in-process-proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let upstream: CombinedMockHandle;
let proxy: InProcessProxyHandle;

const AUTH = { Authorization: "Bearer test-token" };

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
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cache_hit_rate: number | null;
}

async function fetchEvents(date: string): Promise<UsageEventRow[]> {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/events?date=${date}`, {
    headers: AUTH,
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as UsageEventRow[];
}

beforeAll(async () => {
  upstream = startCombinedMock({ limit: 8, hardCap: 16, planName: "Code Pro" });
  proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    umansApiKey: "test-key",
    dashboardToken: "test-token",
    warmerEnabled: false,
    releaseCooldownMs: 0,
    usageRefreshMs: 100,
  });
  await proxy.usage.refresh();
});

afterAll(async () => {
  await proxy.kill();
  upstream.close();
});

describe("Integration: usage events flow (in-process, deterministic)", () => {
  const today = () => new Date().toISOString().slice(0, 10);

  test("no events for initial normal state", async () => {
    const events = await fetchEvents(today());
    const relevant = events.filter(
      (e) => e.tuple_kind === "priority" || e.tuple_kind === "service_mode",
    );
    expect(relevant.length).toBe(0);
  });

  test("priority onset then resolved links previous_event_id", async () => {
    upstream.setTokens({ tokensIn: 1000, tokensOut: 500, tokensCached: 500 });
    upstream.setPriority({ low: true, boxedUntil: Date.now() + 3600_000, reason: "hard_cap_hit" });
    await proxy.usage.refresh();
    await sleep(50);

    const afterOnset = await fetchEvents(today());
    const onset = afterOnset.find((e) => e.tuple_kind === "priority" && e.transition === "onset");
    expect(onset).toBeDefined();
    expect(onset!.previous_event_id).toBeNull();
    expect(onset!.priority_low).toBe(1);
    expect(onset!.boxed_reason).toBe("hard_cap_hit");

    upstream.setPriority({ low: false, boxedUntil: null, reason: null });
    await proxy.usage.refresh();
    await sleep(50);

    const afterResolved = await fetchEvents(today());
    const resolved = afterResolved.find(
      (e) =>
        e.tuple_kind === "priority" &&
        e.transition === "resolved" &&
        e.previous_event_id === onset!.id,
    );
    expect(resolved).toBeDefined();
    expect(resolved!.priority_low).toBe(0);
  });

  test("service_mode onset then morph links previous_event_id", async () => {
    upstream.setServiceMode({ current: "degraded", resetsAt: Date.now() + 3600_000 });
    await proxy.usage.refresh();
    await sleep(50);

    const afterOnset = await fetchEvents(today());
    const smOnset = afterOnset.find(
      (e) => e.tuple_kind === "service_mode" && e.transition === "onset",
    );
    expect(smOnset).toBeDefined();
    expect(smOnset!.service_mode_current).toBe("degraded");
    expect(smOnset!.service_mode_resets_at).not.toBeNull();
    expect(smOnset!.previous_event_id).toBeNull();

    upstream.setServiceMode({ current: "severe", resetsAt: Date.now() + 7200_000 });
    await proxy.usage.refresh();
    await sleep(50);

    const afterMorph = await fetchEvents(today());
    const morph = afterMorph.find(
      (e) =>
        e.tuple_kind === "service_mode" &&
        e.transition === "morph" &&
        e.previous_event_id === smOnset!.id,
    );
    expect(morph).toBeDefined();
    expect(morph!.service_mode_current).toBe("severe");
  });

  test("non-transitioning snapshot (tokens only) produces no new events", async () => {
    const before = (await fetchEvents(today())).length;
    upstream.setTokens({ tokensIn: 9999, tokensOut: 1111, tokensCached: 222 });
    await proxy.usage.refresh();
    await sleep(50);
    const after = (await fetchEvents(today())).length;
    expect(after).toBe(before);
  });

  test("date=today alias works", async () => {
    const explicit = await fetchEvents(today());
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/events?date=today`, {
      headers: AUTH,
    });
    expect(res.ok).toBe(true);
    const aliased = (await res.json()) as UsageEventRow[];
    expect(aliased.length).toBe(explicit.length);
  });

  test("dashboard token auth enforced on events endpoint", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/events?date=${today()}`);
    expect(res.status).toBe(401);
  });
});
