import { expect, mock, test } from "bun:test";
import { UmansUsageClient } from "../src/usage.js";
import { buildSnapshot, failSafeSnapshot } from "../src/usage/parser.js";

const baseConfig = {
  target: "https://api.code.umans.ai",
  umansApiKey: "sk-test-key",
  usageRefreshMs: 5000,
};

const validRawResponse = {
  plan: { display_name: "Code Max" },
  limits: {
    requests: { limit: 200, hard_cap: 400, burst_pct: 1.0, window_seconds: 18000 },
    concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
  },
  usage: {
    requests_in_window: 48,
    remaining_requests: 152,
    concurrent_sessions: 1,
    tokens_in: 1200000,
    tokens_out: 340000,
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
    expect(snap.plan).toBe("Code Max");
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
    expect(snap.plan).toBe("Code Max");
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
  // No timer set, no crash
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

test("Code Pro plan detected correctly", async () => {
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
    expect(snap.plan).toBe("Code Pro");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Code Max (Founding Seat) variant is classified as Code Max", async () => {
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
    expect(snap.plan).toBe("Code Max");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Code Pro (Annual) variant is classified as Code Pro", async () => {
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
    expect(snap.plan).toBe("Code Pro");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildSnapshot parses service_mode correctly", () => {
  const raw = {
    ...validRawResponse,
    usage: {
      ...validRawResponse.usage,
      service_mode: { current: "degraded", resets_at: 1893456000 },
    },
  };
  const snap = buildSnapshot(raw, true);
  expect(snap.serviceMode.current).toBe("degraded");
  expect(snap.serviceMode.resetsAt).toBe(1893456000);
});

test("buildSnapshot defaults service_mode when absent", () => {
  const { service_mode: _, ...usageWithoutServiceMode } = validRawResponse.usage;
  const raw = { ...validRawResponse, usage: usageWithoutServiceMode };
  const snap = buildSnapshot(raw, true);
  expect(snap.serviceMode.current).toBe("normal");
  expect(snap.serviceMode.resetsAt).toBeNull();
});

test("failSafeSnapshot sets service_mode to normal", () => {
  const snap = failSafeSnapshot();
  expect(snap.serviceMode.current).toBe("normal");
  expect(snap.serviceMode.resetsAt).toBeNull();
});
