import { expect, test } from "bun:test";
import type { CaptureDB } from "../src/db.js";
import { WriteQueue } from "../src/queue.js";
import type { ProxyConfig, RequestMeta, ResponseMeta } from "../src/types.js";

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

/** Access private fields on WriteQueue for testing. */
function queueInternals(q: WriteQueue): {
  retryTimer: ReturnType<typeof setTimeout> | null;
  flushRetryCount: number;
} {
  return q as unknown as {
    retryTimer: ReturnType<typeof setTimeout> | null;
    flushRetryCount: number;
  };
}

/** Silence the logger (which routes warn/error to console.error). */
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

test("flushNow failure re-queues batch and sets a retry timer", async () => {
  const restore = silenceConsole();
  try {
    const flushed: { id: number; res: ResponseMeta }[] = [];
    const db = {
      batchUpdate: async () => {
        throw new Error("SQLite BUSY");
      },
    } as unknown as CaptureDB;

    const config = { ...baseConfig, queueMaxDepth: 100, flushBatch: 2 };
    const queue = new WriteQueue(db, config);

    queue.queueUpdate(1, reqMeta, makeRes(1));
    queue.queueUpdate(2, reqMeta, makeRes(2));
    await queue.flushNow();

    // Batch re-queued at front
    expect(queue.length).toBe(2);
    expect(flushed.length).toBe(0);

    // Retry timer scheduled
    const { retryTimer } = queueInternals(queue);
    expect(retryTimer).toBeDefined();
    expect(retryTimer).not.toBeNull();
    if (retryTimer) clearTimeout(retryTimer);
  } finally {
    restore();
  }
});

test("retry timer fires guardedFlush after backoff and succeeds, clearing the retry count", async () => {
  const restore = silenceConsole();
  try {
    const flushed: { id: number; res: ResponseMeta }[] = [];
    let callCount = 0;
    const db = {
      batchUpdate: async (batch: { id: number; res: ResponseMeta }[]) => {
        callCount++;
        if (callCount === 1) throw new Error("transient");
        flushed.push(...batch);
      },
    } as unknown as CaptureDB;

    const config = { ...baseConfig, queueMaxDepth: 100, flushBatch: 2 };
    const queue = new WriteQueue(db, config);

    queue.queueUpdate(1, reqMeta, makeRes(1));
    queue.queueUpdate(2, reqMeta, makeRes(2));
    await queue.flushNow();

    // First flush failed — retry timer set, count = 1
    expect(queue.length).toBe(2);
    const { flushRetryCount: countAfterFail } = queueInternals(queue);
    expect(countAfterFail).toBe(1);

    // Wait for the retry timer (1s backoff) to fire guardedFlush → success
    await Bun.sleep(1300);

    // Batch flushed successfully
    expect(queue.length).toBe(0);
    expect(flushed.map((it) => it.id)).toEqual([1, 2]);

    // Retry count reset and timer cleared on success
    const { retryTimer, flushRetryCount } = queueInternals(queue);
    expect(retryTimer).toBeNull();
    expect(flushRetryCount).toBe(0);
  } finally {
    restore();
  }
});

test("after 10 failed retries, batch is dropped with a warning log and retry count resets", async () => {
  const realError = console.error;
  const errorCalls: string[] = [];
  console.error = ((...args: unknown[]) => {
    errorCalls.push(args.map((a) => (typeof a === "string" ? a : String(a))).join(" "));
  }) as never;
  try {
    const db = {
      batchUpdate: async () => {
        throw new Error("disk full");
      },
    } as unknown as CaptureDB;

    const config = { ...baseConfig, queueMaxDepth: 100, flushBatch: 2 };
    const queue = new WriteQueue(db, config);

    queue.queueUpdate(1, reqMeta, makeRes(1));
    queue.queueUpdate(2, reqMeta, makeRes(2));

    // Drive 10 failed flushNow cycles (each increments retry count by 1)
    for (let i = 0; i < 10; i++) {
      await queue.flushNow();
    }

    // After 10 failures the batch should be dropped (queue empty) and a warning logged
    expect(queue.length).toBe(0);

    // Retry count reset after drop
    const { flushRetryCount, retryTimer } = queueInternals(queue);
    expect(flushRetryCount).toBe(0);
    expect(retryTimer).toBeNull();

    // At least one error log mentions the drop (logger.warn routes to console.error)
    const dropLogged = errorCalls.some((m) => /drop/i.test(m));
    expect(dropLogged).toBe(true);
  } finally {
    console.error = realError;
  }
});
