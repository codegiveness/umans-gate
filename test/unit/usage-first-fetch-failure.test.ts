import { expect, mock, test } from "bun:test";
import { ConcurrencyGate } from "../../src/limiter/index.js";
import type { UsageSnapshot } from "../../src/types.js";
import { UmansUsageClient } from "../../src/usage.js";

const baseConfig = {
  target: "https://api.code.umans.ai",
  umansApiKey: "sk-test-key",
  usageRefreshMs: 5000,
};

// Mirror of src/index.ts:325-334 usage.onChange callback — the surface U3 protects.
const gateOpts = {
  hardCap: 4,
  softLimit: 4,
  releaseCooldownMs: 0,
  breakerThreshold: 3,
  breakerWindowMs: 5000,
  breakerCooldownMs: 50,
  maxQueueDepth: 10,
  queueTimeoutMs: 100,
};

function _wireGate(client: UmansUsageClient): ConcurrencyGate {
  const gate = new ConcurrencyGate(gateOpts);
  client.onChange((snap) => {
    gate.setSoftLimit(snap.concurrencySoftLimit);
    let effective = snap.concurrencySoftLimit;
    if (snap.priorityLow) effective = Math.max(1, effective - 1);
    gate.resize(effective);
  });
  return gate;
}

const validRawResponse = {
  user_id: "test-user-123",
  plan: { display_name: "Code Max", slug: "code_max" },
  limits: {
    requests: { limit: 200, hard_cap: 400, burst_pct: 1.0, window_seconds: 18000 },
    concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
  },
  window: {
    started_at: "2026-07-16T04:51:53.756363+00:00",
    resets_at: "2026-07-16T09:51:53.756363+00:00",
    remaining_minutes: 206,
  },
  usage: {
    requests_in_window: 48,
    weighted_in_window: 24.0,
    remaining_requests: 152,
    weighted_remaining_requests: 76,
    concurrent_sessions: 1,
    weighted_concurrent_sessions: 0.5,
    tokens_in: 1200000,
    tokens_out: 340000,
    tokens_cached: 50000,
    priority: { low: false, boxed_until: null, reason: null },
    service_mode: { current: "interactive", resets_at: null },
  },
};

const okResponse = () => new Response(JSON.stringify(validRawResponse), { status: 200 });

const networkError = () => {
  throw new Error("network error");
};

test("U3: first-fetch failure does NOT stamp gate to softLimit=1 (onChange not fired)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    networkError();
  }) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    let onChangeCalls = 0;
    const gate = new ConcurrencyGate(gateOpts);
    client.onChange((snap) => {
      onChangeCalls++;
      gate.setSoftLimit(snap.concurrencySoftLimit);
    });
    await client.refresh();
    // Bug U3: previously fired onChange with failSafeSnapshot (softLimit=1),
    // stamping the gate to 1 permanently. Fix: do not fire onChange on first failure.
    expect(onChangeCalls).toBe(0);
    // Gate keeps its initial config softLimit=4.
    expect(gate.getLimit()).toBe(4);
    // getSnapshot() still returns the fail-safe worst-case for direct queries —
    // that's the read path, not the gate-stamping write path.
    const snap = client.getSnapshot();
    expect(snap.ok).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("U3: first-fetch failure then success updates gate with real values", async () => {
  const callCount = { v: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    callCount.v++;
    if (callCount.v === 1) {
      networkError();
    }
    return okResponse();
  }) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    const receivedSnaps: UsageSnapshot[] = [];
    const gate = new ConcurrencyGate(gateOpts);
    client.onChange((snap) => {
      receivedSnaps.push(snap);
      gate.setSoftLimit(snap.concurrencySoftLimit);
    });
    // First fetch fails — onChange must NOT fire (bug U3).
    await client.refresh();
    expect(receivedSnaps.length).toBe(0);
    expect(gate.getLimit()).toBe(4); // unchanged from config
    // Second fetch succeeds — onChange fires with real concurrency limit (4).
    await client.refresh();
    expect(receivedSnaps.length).toBe(1);
    expect(receivedSnaps[0].ok).toBe(true);
    expect(receivedSnaps[0].concurrencySoftLimit).toBe(4);
    expect(gate.getLimit()).toBe(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("U3: subsequent failure after success preserves last-known-good (onChange fires with ok:false)", async () => {
  const callCount = { v: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    callCount.v++;
    if (callCount.v === 1) return okResponse();
    networkError();
  }) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    const receivedSnaps: UsageSnapshot[] = [];
    const gate = new ConcurrencyGate(gateOpts);
    client.onChange((snap) => {
      receivedSnaps.push(snap);
      gate.setSoftLimit(snap.concurrencySoftLimit);
    });
    // First fetch succeeds — LKG established at softLimit=4.
    await client.refresh();
    expect(receivedSnaps.length).toBe(1);
    expect(gate.getLimit()).toBe(4);
    // Second fetch fails — onChange MUST fire (preserves LKG, marks ok:false)
    // so priority-low adjustments can still apply.
    await client.refresh();
    expect(receivedSnaps.length).toBe(2);
    expect(receivedSnaps[1].ok).toBe(false);
    // LKG softLimit=4 preserved, gate stays at 4 (not stamped down to 1).
    expect(receivedSnaps[1].concurrencySoftLimit).toBe(4);
    expect(gate.getLimit()).toBe(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
