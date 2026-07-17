// Regression test for Q2: Fix shutdown data loss when flushNow fails and
// worker terminates.
//
// BEFORE: The shutdown sequence in src/index.ts called `queue.flushNow()`
// once, then immediately closed writeStore, persistentStore, and db.
// When flushNow failed (e.g. SQLite BUSY), the batch was re-queued at the
// front of the WriteQueue, but shutdown proceeded to close the store and db.
// The re-queued entries were silently lost — their capture rows stayed in
// "streaming" state forever (phantom rows), and WS clients never learned
// they failed.
//
// AFTER: Before closing the worker store, shutdown retries flushNow up to 3
// times with 1s backoff. If still failing, it drains the queue and marks each
// remaining entry as "failed" (via the onDrop callback from Q1), broadcasting
// a WS state message. Only then does it close the store and db.

import { expect, test } from "bun:test";
import type { CaptureDB } from "../src/db.js";
import { WriteQueue } from "../src/queue.js";
import type {
  CaptureState,
  ProxyConfig,
  RequestMeta,
  ResponseMeta,
  WsMessage,
} from "../src/types.js";
import type { WsBroadcaster } from "../src/ws.js";

const baseConfig: ProxyConfig = {
  port: 1945,
  host: "127.0.0.1",
  target: "https://api.code.umans.ai",
  maxCaptures: 200,
  dbPath: "./test.db",
  viewerPrefix: "/dashboard",
  flushIntervalMs: 50,
  flushBatch: 25,
  queueMaxDepth: 100,
  idleTimeout: 255,
  upstreamProtocol: "http1.1",
  incomingProtocol: "http1.1",
  stampClaudeCode: false,
  stampReasoningEffort: null,
  openaiPath: "chat/completions",
  warmerEnabled: false,
  warmerIntervalMs: 20000,
  warmerPath: "/v1/models",
  umansApiKey: null,
  usageRefreshMs: 60000,
  modelsRefreshMs: 3600000,
  concurrencyHardCap: 1,
  concurrencySoftLimit: 1,
  rateLimitRequests: 0,
  queueTimeoutMs: 30000,
  maxQueueDepth: 256,
  releaseCooldownMs: 1000,
  breakerThreshold: 5,
  breakerWindowMs: 300000,
  breakerCooldownMs: 60000,
  visionStrategy: "never",
  visionTarget: null,
  visionModel: null,
  visionPrompt: "",
  visionPromptVersion: 1,
  visionMaxImages: 5,
  visionMaxDescriptionTokens: 4096,
  visionReasoningEffort: null,
  visionTimeoutMs: 0,
  visionCacheSize: 1000,
  visionCacheTtlMs: 604800000,
  visionCacheMaxRows: 10000,
  visionPersistentCache: true,
  visionConcurrency: 1,
  visionForceInterceptCapable: false,
  visionMaxDimension: 2048,
  visionJpegQuality: 92,
  visionImageFormat: "png",
  visionImageDetail: "high",
  concurrencyMainReservation: 1,
  concurrencyVisionReservation: 1,
  captureBodyMaxBytes: 1_000_000,
  wsBackpressureLimit: 1_048_576,
  wsCloseOnBackpressureLimit: true,
  visionPendingMaxBatch: 50,
  compressionEnabled: false,
  useWriteWorker: false,
  backgroundVision: false,
  upstreamTimeoutMs: 300000,
  dashboardToken: null,
} as const;

const reqMeta: RequestMeta = {
  method: "POST",
  path: "chat/completions",
  request_size: 100,
  started_at: Date.now(),
};

function makeRes(id: number): ResponseMeta {
  return {
    $status: 200,
    $rh: "content-type: application/json",
    $rb: JSON.stringify({ id }),
    $rs: 100,
    $ct: "application/json",
    $sse: 0,
    $dur: 10,
    $fin: Date.now(),
    $status_source: "upstream",
    $gate_reason: null,
    $model: "test-model",
  };
}

/** Silence console.error/warn (logger routes warn+error to console.error). */
function silenceConsole(): () => void {
  const realError = console.error;
  const realWarn = console.warn;
  const sink = () => {};
  console.error = sink as never;
  console.warn = sink as never;
  return () => {
    console.error = realError;
    console.warn = realWarn;
  };
}

interface QueueInternals {
  retryTimer: ReturnType<typeof setTimeout> | null;
  flushRetryCount: number;
}

function queueInternals(q: WriteQueue): QueueInternals {
  return q as unknown as QueueInternals;
}

/** Stub CaptureDB that either succeeds or always fails batchUpdate. */
function makeDb(opts: { failBatchUpdate?: boolean } = {}): {
  db: CaptureDB;
  batchUpdateCalls: { value: number };
  setStateCalls: Array<{ id: number; state: string }>;
} {
  const batchUpdateCalls = { value: 0 };
  const setStateCalls: Array<{ id: number; state: string }> = [];
  const db = {
    batchUpdate: async () => {
      batchUpdateCalls.value++;
      if (opts.failBatchUpdate) throw new Error("SQLite BUSY");
    },
    setState: (id: number, state: string) => {
      setStateCalls.push({ id, state });
    },
  } as unknown as CaptureDB;
  return { db, batchUpdateCalls, setStateCalls };
}

/** Stub WsBroadcaster collecting broadcast messages. */
function makeWs(): { ws: WsBroadcaster; broadcasts: WsMessage[] } {
  const broadcasts: WsMessage[] = [];
  const ws = {
    broadcast: (msg: WsMessage) => {
      broadcasts.push(msg);
    },
  } as unknown as WsBroadcaster;
  return { ws, broadcasts };
}

test("drainForShutdown marks all remaining queue entries as failed and broadcasts state", async () => {
  const restore = silenceConsole();
  try {
    const { db, setStateCalls } = makeDb({ failBatchUpdate: true });
    const { ws, broadcasts } = makeWs();

    // High flushBatch so queueUpdate does NOT auto-flush; we control the queue.
    const config = { ...baseConfig, queueMaxDepth: 100, flushBatch: 100, flushIntervalMs: 60000 };
    const queue = new WriteQueue(db, config, undefined, (dropped) => {
      db.setState(dropped.id, "failed");
      ws.broadcast({ type: "state", captureId: dropped.id, state: "failed" });
    });

    queue.queueUpdate(1, reqMeta, makeRes(1));
    queue.queueUpdate(2, reqMeta, makeRes(2));
    queue.queueUpdate(3, reqMeta, makeRes(3));

    // Let any in-flight auto-flush settle (2nd queueUpdate falls through to
    // guardedFlush even when flushBatch is high, because flushTimer is set).
    await Bun.sleep(10);

    // drainForShutdown should empty the queue and mark each entry failed
    queue.drainForShutdown();

    expect(queue.length).toBe(0);
    // All entries that were in the queue at drain time are marked failed.
    // (Some may have been re-queued by the failed auto-flush; all should be
    // drained and marked.)
    expect(setStateCalls.length).toBeGreaterThanOrEqual(3);
    const failedIds = setStateCalls.filter((s) => s.state === "failed").map((s) => s.id);
    expect(failedIds).toContain(1);
    expect(failedIds).toContain(2);
    expect(failedIds).toContain(3);

    const stateMsgs = broadcasts.filter(
      (m): m is { type: "state"; captureId: number; state: CaptureState } =>
        m.type === "state" && m.state === "failed",
    );
    expect(stateMsgs.length).toBeGreaterThanOrEqual(3);
  } finally {
    restore();
  }
});

test("drainForShutdown on empty queue is a no-op", () => {
  const { db, setStateCalls } = makeDb();
  const { ws, broadcasts } = makeWs();

  const config = { ...baseConfig, queueMaxDepth: 100, flushBatch: 2 };
  const queue = new WriteQueue(db, config, undefined, (dropped) => {
    db.setState(dropped.id, "failed");
    ws.broadcast({ type: "state", captureId: dropped.id, state: "failed" });
  });

  queue.drainForShutdown();

  expect(queue.length).toBe(0);
  expect(setStateCalls.length).toBe(0);
  expect(broadcasts.length).toBe(0);
});

test("drainForShutdown without onDrop callback just empties the queue (no crash)", () => {
  const restore = silenceConsole();
  try {
    const { db } = makeDb({ failBatchUpdate: true });
    const config = { ...baseConfig, queueMaxDepth: 100, flushBatch: 2 };
    const queue = new WriteQueue(db, config);

    queue.queueUpdate(1, reqMeta, makeRes(1));
    queue.queueUpdate(2, reqMeta, makeRes(2));

    queue.drainForShutdown();
    expect(queue.length).toBe(0);
  } finally {
    restore();
  }
});

test("shutdown contract: working DB → all entries flushed, no data loss", async () => {
  const { db, setStateCalls } = makeDb(); // batchUpdate succeeds
  const { ws, broadcasts } = makeWs();

  const config = { ...baseConfig, queueMaxDepth: 100, flushBatch: 2 };
  const queue = new WriteQueue(
    db,
    config,
    (messages) => {
      for (const msg of messages) ws.broadcast(msg);
    },
    (dropped) => {
      db.setState(dropped.id, "failed");
      ws.broadcast({ type: "state", captureId: dropped.id, state: "failed" });
    },
  );

  queue.queueUpdate(1, reqMeta, makeRes(1));
  queue.queueUpdate(2, reqMeta, makeRes(2));

  // Simulate shutdown: flushNow succeeds, then drainForShutdown (should be no-op)
  await queue.flushNow();
  expect(queue.length).toBe(0);
  queue.drainForShutdown();

  // No entries marked failed (all flushed successfully)
  expect(setStateCalls.length).toBe(0);
  // No state:"failed" broadcasts (update broadcasts are fine)
  const failedMsgs = broadcasts.filter(
    (m): m is { type: "state"; captureId: number; state: CaptureState } =>
      m.type === "state" && m.state === "failed",
  );
  expect(failedMsgs.length).toBe(0);
});

test("shutdown contract: broken DB → entries retried 3× then marked failed, no phantom streaming rows", async () => {
  const restore = silenceConsole();
  try {
    const { db, batchUpdateCalls, setStateCalls } = makeDb({ failBatchUpdate: true });
    const { ws, broadcasts } = makeWs();

    const config = { ...baseConfig, queueMaxDepth: 100, flushBatch: 2 };
    const queue = new WriteQueue(db, config, undefined, (dropped) => {
      db.setState(dropped.id, "failed");
      ws.broadcast({ type: "state", captureId: dropped.id, state: "failed" });
    });

    queue.queueUpdate(1, reqMeta, makeRes(1));
    queue.queueUpdate(2, reqMeta, makeRes(2));

    // Simulate shutdown: retry flushNow 3 times, each fails, then drainForShutdown
    for (let i = 0; i < 3; i++) {
      await queue.flushNow();
    }
    expect(batchUpdateCalls.value).toBe(3);
    // Items still in queue (re-queued after each failed flush)
    expect(queue.length).toBe(2);

    // Clear any retry timer so it doesn't fire after drain
    const { retryTimer } = queueInternals(queue);
    if (retryTimer) clearTimeout(retryTimer);

    // Now drain — marks all as failed
    queue.drainForShutdown();
    expect(queue.length).toBe(0);

    // All entries marked failed (no phantom "streaming" rows left)
    expect(setStateCalls.length).toBe(2);
    for (const call of setStateCalls) {
      expect(call.state).toBe("failed");
    }
    const failedIds = setStateCalls.map((s) => s.id);
    expect(failedIds).toContain(1);
    expect(failedIds).toContain(2);

    // WS state:"failed" broadcasts for each
    const failedMsgs = broadcasts.filter(
      (m): m is { type: "state"; captureId: number; state: CaptureState } =>
        m.type === "state" && m.state === "failed",
    );
    expect(failedMsgs.length).toBe(2);
    const broadcastIds = failedMsgs.map((m) => m.captureId);
    expect(broadcastIds).toContain(1);
    expect(broadcastIds).toContain(2);
  } finally {
    restore();
  }
});

test("shutdown contract: shutdown completes within 30s deadline even with broken DB", async () => {
  const restore = silenceConsole();
  try {
    const { db } = makeDb({ failBatchUpdate: true });
    const { ws } = makeWs();

    const config = { ...baseConfig, queueMaxDepth: 100, flushBatch: 2 };
    const queue = new WriteQueue(db, config, undefined, (dropped) => {
      db.setState(dropped.id, "failed");
      ws.broadcast({ type: "state", captureId: dropped.id, state: "failed" });
    });

    queue.queueUpdate(1, reqMeta, makeRes(1));
    queue.queueUpdate(2, reqMeta, makeRes(2));

    const start = Date.now();
    // Simulate the full shutdown drain sequence (3 retries with 0 backoff for test speed,
    // then drain). Real shutdown uses 1s backoff — total worst case ~3s + drain.
    for (let i = 0; i < 3; i++) {
      await queue.flushNow();
    }
    const { retryTimer } = queueInternals(queue);
    if (retryTimer) clearTimeout(retryTimer);
    queue.drainForShutdown();
    const elapsed = Date.now() - start;

    // Must complete well under 30s (even with 1s backoff in production, 3 retries = 3s max)
    expect(elapsed).toBeLessThan(30000);
    expect(queue.length).toBe(0);
  } finally {
    restore();
  }
});
