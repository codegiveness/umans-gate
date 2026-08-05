import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CombinedMockHandle, startCombinedMock } from "../helpers/combined-mock";
import { type InProcessProxyHandle, startInProcessProxy } from "../helpers/in-process-proxy";

let upstream: CombinedMockHandle;
let proxy: InProcessProxyHandle;

beforeAll(async () => {
  upstream = startCombinedMock({ limit: 4, hardCap: 8 });
  proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    umansApiKey: "test-key",
    dashboardToken: "test-token",
    warmerEnabled: false,
    usageRefreshMs: 100,
  });
});

afterAll(async () => {
  await proxy.kill();
  upstream.close();
});

describe("settable usage mock drives the rate-gate data source", () => {
  test("setUsage propagates requests limits to snapshot and /dashboard/api/usage", async () => {
    upstream.setUsage({ requestsInWindow: 20, requestsHardCap: 100, requestsLimit: 20 });
    await proxy.usage.refresh();

    const snap = proxy.usage.getSnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.requestsInWindow).toBe(20);
    expect(snap.requestsHardCap).toBe(100);
    expect(snap.requestsLimit).toBe(20);

    // The exposed viewer surface surfaced the same gate data the rate-gate reads.
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/usage`, {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.ok).toBe(true);
    const body = (await res.json()) as {
      requestsInWindow: number;
      requestsHardCap: number | null;
      requestsLimit: number | null;
    };
    expect(body.requestsInWindow).toBe(20);
    expect(body.requestsHardCap).toBe(100);
    expect(body.requestsLimit).toBe(20);
  });
});
