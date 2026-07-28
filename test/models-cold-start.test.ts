// Cold-start retry behavior for ModelsClient.
//
// When the proxy boots and the network isn't ready yet, the initial fetch
// fails. The client retries every COLD_START_INTERVAL_MS (30s in prod) up
// to COLD_START_MAX_RETRIES (10) times before falling back to the normal
// refreshMs interval.
//
// Test approach: export a mutable COLD_START config from models.ts so tests
// can override the interval/maxRetries for fast feedback without touching
// production code paths or adding constructor params.
// Production reads COLD_START.intervalMs / COLD_START.maxRetries at runtime.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { COLD_START, ModelsClient } from "../src/models.js";

interface MockUpstream {
  server: ReturnType<typeof Bun.serve>;
  port: number;
  requestCount: { models: number };
}

function startMockUpstream(opts: { failFirst: number }): MockUpstream {
  let failCount = 0;
  const requestCount = { models: 0 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/models") {
        requestCount.models++;
        if (failCount < opts.failFirst) {
          failCount++;
          return new Response("service unavailable", { status: 503 });
        }
        return Response.json({
          data: [{ id: "test-model", context_length: 8192, pricing: { input: 1, output: 1 } }],
        });
      }
      if (url.pathname === "/v1/models/info") {
        return Response.json({ data: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { server, port: server.port ?? 0, requestCount };
}

const REAL_INTERVAL = COLD_START.intervalMs;
const REAL_MAX = COLD_START.maxRetries;

beforeAll(() => {
  COLD_START.intervalMs = 50;
  COLD_START.maxRetries = 3;
});

afterAll(() => {
  COLD_START.intervalMs = REAL_INTERVAL;
  COLD_START.maxRetries = REAL_MAX;
});

/** Wait for predicate to be true, polling every 10ms. */
async function waitFor(pred: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await Bun.sleep(10);
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ─── Cold-start recovery ───

test("cold-start recovery: fails first 2, then succeeds", async () => {
  const mock = startMockUpstream({ failFirst: 2 });
  const client = new ModelsClient({
    target: `http://127.0.0.1:${mock.port}`,
    refreshMs: 200,
  });
  try {
    client.start();
    // Not ready immediately (initial fetch fails).
    await waitFor(() => mock.requestCount.models >= 1, 2000);
    expect(client.isReady()).toBe(false);

    // After 2 failures, 3rd succeeds → ready.
    await waitFor(() => client.isReady(), 3000);
    expect(client.list().length).toBeGreaterThan(0);
    expect(mock.requestCount.models).toBeGreaterThanOrEqual(3);

    // Wait past cold-start interval to verify steady-state kicks in.
    // After recovery, next fetch should be at refreshMs (200ms), not
    // cold-start interval (50ms). Count fetches over a 600ms window.
    const countBefore = mock.requestCount.models;
    await Bun.sleep(600);
    const countAfter = mock.requestCount.models;
    const fetchesInWindow = countAfter - countBefore;
    // At 200ms interval, ~3 fetches in 600ms. At 50ms cold-start, ~12.
    // Allow generous range: steady-state should be < 6.
    expect(fetchesInWindow).toBeLessThan(6);
  } finally {
    client.stop();
    mock.server.stop();
  }
});

// ─── Cold-start exhaustion ───

test("cold-start exhaustion: fails all, switches to normal interval after max retries", async () => {
  const mock = startMockUpstream({ failFirst: 999 });
  const client = new ModelsClient({
    target: `http://127.0.0.1:${mock.port}`,
    refreshMs: 200,
  });
  try {
    client.start();
    // Wait for cold-start phase to exhaust (3 retries at 50ms = ~200ms).
    await waitFor(() => mock.requestCount.models >= 4, 5000); // 1 initial + 3 retries
    expect(client.isReady()).toBe(false);
    expect(mock.requestCount.models).toBe(4);

    // After exhaustion, should switch to refreshMs (200ms).
    // Count fetches over 600ms window. At 200ms, ~3 fetches.
    const countBefore = mock.requestCount.models;
    await Bun.sleep(600);
    const countAfter = mock.requestCount.models;
    const fetchesInWindow = countAfter - countBefore;
    // Steady-state at 200ms → ~3 fetches. Cold-start at 50ms would be ~12.
    expect(fetchesInWindow).toBeLessThan(6);
  } finally {
    client.stop();
    mock.server.stop();
  }
});

// ─── Immediate success ───

test("immediate success: no cold-start retries", async () => {
  const mock = startMockUpstream({ failFirst: 0 });
  const client = new ModelsClient({
    target: `http://127.0.0.1:${mock.port}`,
    refreshMs: 200,
  });
  try {
    client.start();
    // Should be ready almost immediately — first fetch succeeds.
    await waitFor(() => client.isReady(), 2000);
    expect(client.list().length).toBeGreaterThan(0);

    // Only 1 fetch so far (the initial one). No cold-start retries fired.
    expect(mock.requestCount.models).toBe(1);

    // Wait for steady-state interval to fire at least once.
    await waitFor(() => mock.requestCount.models >= 2, 2000);
  } finally {
    client.stop();
    mock.server.stop();
  }
});
