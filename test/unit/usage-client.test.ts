// Unit tests: UmansUsageClient with mocked fetch.
// Verifies snapshot lifecycle, fail-safe defaults, LKG preservation, plan
// detection, onChange firing — all via direct client.refresh() calls.

import { expect, mock, test } from "bun:test";
import { UmansUsageClient } from "../../src/usage.js";

const baseConfig = {
  target: "https://api.code.umans.ai",
  umansApiKey: "sk-test-key",
  usageRefreshMs: 5000,
};

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

test("getSnapshot with no fetch returns fail-safe worst-case", () => {
  const client = new UmansUsageClient(baseConfig);
  const snap = client.getSnapshot();
  expect(snap.ok).toBe(false);
  expect(snap.plan).toBe("unknown");
  expect(snap.priorityLow).toBe(true);
  expect(snap.concurrentSessions).toBe(0);
  expect(snap.concurrencySoftLimit).toBe(1);
  expect(snap.concurrencyHardCap).toBe(1);
});

test("successful refresh populates snapshot with ok=true", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify(validRawResponse), { status: 200 }),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.ok).toBe(true);
    expect(snap.plan).toBe("unknown");
    expect(snap.concurrencySoftLimit).toBe(4);
    expect(snap.concurrencyHardCap).toBe(8);
    expect(snap.requestsInWindow).toBe(48);
    expect(snap.requestsRemaining).toBe(152);
    expect(snap.priorityLow).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch failure with no LKG returns worst-case with ok=false", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    throw new Error("network error");
  }) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.ok).toBe(false);
    expect(snap.priorityLow).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetch failure with LKG keeps last snapshot but marks ok=false", async () => {
  const callCount = { v: 0 };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(async () => {
    callCount.v++;
    if (callCount.v === 1) {
      return new Response(JSON.stringify(validRawResponse), { status: 200 });
    }
    throw new Error("network error");
  }) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    expect(client.getSnapshot().ok).toBe(true);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.ok).toBe(false);
    expect(snap.plan).toBe("unknown");
    expect(snap.concurrencySoftLimit).toBe(4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("HTTP 401 triggers fail-safe path", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () => new Response("Unauthorized", { status: 401 }),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.ok).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("start without API key is a no-op", () => {
  const client = new UmansUsageClient({ ...baseConfig, umansApiKey: null });
  client.start();
  client.stop();
});

test("onChange callback fires on snapshot change", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify(validRawResponse), { status: 200 }),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    let calls = 0;
    client.onChange(() => {
      calls++;
    });
    await client.refresh();
    expect(calls).toBe(1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("snapshot plan is unknown for Code Pro display_name (deprecated-plan contract)", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () =>
      new Response(JSON.stringify({ ...validRawResponse, plan: { display_name: "Code Pro" } }), {
        status: 200,
      }),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.plan).toBe("unknown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Code Max (Founding Seat) display_name still yields plan unknown", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({ ...validRawResponse, plan: { display_name: "Code Max (Founding Seat)" } }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.plan).toBe("unknown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Code Pro (Annual) display_name still yields plan unknown", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(
    async () =>
      new Response(
        JSON.stringify({ ...validRawResponse, plan: { display_name: "Code Pro (Annual)" } }),
        { status: 200 },
      ),
  ) as unknown as typeof fetch;
  try {
    const client = new UmansUsageClient(baseConfig);
    await client.refresh();
    const snap = client.getSnapshot();
    expect(snap.plan).toBe("unknown");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
