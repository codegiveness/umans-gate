import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CombinedMockHandle, startCombinedMock } from "../helpers/combined-mock";
import { type InProcessProxyHandle, startInProcessProxy } from "../helpers/in-process-proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let upstream: CombinedMockHandle;
let proxy: InProcessProxyHandle;

const AUTH = { Authorization: "Bearer test-token" };

interface UsageSampleRow {
  id: number;
  fetched_at: number;
  ok: number;
  plan: string;
  plan_slug: string | null;
  concurrency_soft_limit: number;
  concurrency_hard_cap: number;
  priority_low: number;
  service_mode_current: string;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
}

async function fetchSamples(date: string): Promise<UsageSampleRow[]> {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/samples?date=${date}`, {
    headers: AUTH,
  });
  expect(res.ok).toBe(true);
  return (await res.json()) as UsageSampleRow[];
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
});

afterAll(async () => {
  await proxy.kill();
  upstream.close();
});

describe("Integration: usage history samples (in-process, deterministic)", () => {
  const today = () => new Date().toISOString().slice(0, 10);

  test("usage_samples table created and rows written from poll", async () => {
    await proxy.usage.refresh();
    const rows = await fetchSamples(today());
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const row = rows[0];
    expect(row.plan).toBe("Code Pro");
    expect(row.concurrency_hard_cap).toBe(16);
    expect(row.concurrency_soft_limit).toBe(8);
    expect(row.service_mode_current).toBe("normal");
    expect(row.priority_low).toBe(0);
  });

  test("coalescing: identical snapshots produce one row", async () => {
    await proxy.usage.refresh();
    const beforeCount = (await fetchSamples(today())).length;
    // Refresh again — ambient values unchanged, should coalesce.
    await proxy.usage.refresh();
    await sleep(50);
    const afterCount = (await fetchSamples(today())).length;
    expect(afterCount).toBe(beforeCount);
  });

  test("date=today alias works", async () => {
    const explicit = await fetchSamples(today());
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/samples?date=today`, {
      headers: AUTH,
    });
    expect(res.ok).toBe(true);
    const aliased = (await res.json()) as UsageSampleRow[];
    expect(aliased.length).toBe(explicit.length);
  });

  test("changing /v1/usage writes a new row with updated soft limit", async () => {
    upstream.setLimit(12);
    await proxy.usage.refresh();
    const rows = await fetchSamples(today());
    const last = rows[0];
    expect(last.concurrency_soft_limit).toBe(12);
  });

  test("dashboard token auth enforced on samples endpoint", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage/samples?date=${today()}`);
    expect(res.status).toBe(401);
  });
});
