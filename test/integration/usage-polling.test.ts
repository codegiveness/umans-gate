import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type CombinedMockHandle, startCombinedMock } from "../helpers/combined-mock";
import { type InProcessProxyHandle, startInProcessProxy } from "../helpers/in-process-proxy";

let upstream: CombinedMockHandle;
let proxy: InProcessProxyHandle;

beforeAll(async () => {
  upstream = startCombinedMock({ limit: 4, hardCap: 8, planName: "Code Max" });
  proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    umansApiKey: "test-key",
    dashboardToken: "test-token",
    warmerEnabled: false,
    releaseCooldownMs: 0,
    usageRefreshMs: 100,
    concurrencySoftLimit: 8,
    concurrencyHardCap: 16,
  });
});

afterAll(async () => {
  await proxy.kill();
  upstream.close();
});

describe("Integration: usage polling applies limit to gate (deterministic, no polling loops)", () => {
  test("refresh() applies upstream limit to gate.getLimit()", async () => {
    // Force a fetch deterministically — no polling loop.
    await proxy.usage.refresh();
    const snap = proxy.usage.getSnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.plan).toBe("Code Max");
    expect(snap.concurrencySoftLimit).toBe(4);
    expect(snap.concurrencyHardCap).toBe(8);
    // Gate effective limit should match the upstream soft limit.
    expect(proxy.gate.getLimit()).toBe(4);
  });

  test("setLimit→refresh resizes gate", async () => {
    upstream.setLimit(6);
    await proxy.usage.refresh();
    const snap = proxy.usage.getSnapshot();
    expect(snap.concurrencySoftLimit).toBe(6);
    expect(proxy.gate.getLimit()).toBe(6);
  });

  test("priority low clamps gate to 1", async () => {
    upstream.setPriority({ low: true, boxedUntil: Date.now() + 3600_000, reason: "hard_cap_hit" });
    await proxy.usage.refresh();
    const snap = proxy.usage.getSnapshot();
    expect(snap.priorityLow).toBe(true);
    expect(proxy.gate.getLimit()).toBe(1);
  });

  test("priority clear restores gate to soft limit", async () => {
    upstream.setPriority({ low: false, boxedUntil: null, reason: null });
    await proxy.usage.refresh();
    const snap = proxy.usage.getSnapshot();
    expect(snap.priorityLow).toBe(false);
    expect(proxy.gate.getLimit()).toBe(6);
  });

  test("rate_limit boxed reason keeps gate at effective limit (not clamped to 1)", async () => {
    upstream.setPriority({ low: true, boxedUntil: Date.now() + 3600_000, reason: "rate_limited" });
    await proxy.usage.refresh();
    const snap = proxy.usage.getSnapshot();
    expect(snap.priorityLow).toBe(true);
    expect(snap.boxedReason).toBe("rate_limited");
    // rate_limit* reasons do NOT clamp to 1, but priorityLow still decrements by 1.
    // effective = softLimit(6) - 1(priorityLow) = 5.
    expect(proxy.gate.getLimit()).toBe(5);
  });
});
