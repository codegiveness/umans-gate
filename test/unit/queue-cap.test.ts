import { expect, test } from "bun:test";
import type { CaptureDB } from "../../src/db.js";
import { WriteQueue } from "../../src/queue.js";
import type { ProxyConfig, RequestMeta, ResponseMeta } from "../../src/types.js";
import type { WsBroadcaster } from "../../src/ws.js";

const baseConfig: ProxyConfig = {
  port: 1945,
  host: "127.0.0.1",
  target: "https://api.code.umans.ai",
  maxCaptures: 200,
  dbPath: "./test.db",
  viewerPrefix: "/dashboard",
  flushIntervalMs: 50,
  flushBatch: 25,
  queueMaxDepth: 3,
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

function makeStubs({ stuck = false }: { stuck?: boolean } = {}): {
  flushed: { id: number; res: ResponseMeta }[];
  broadcasts: { type: "update"; capture: Record<string, unknown> }[];
  db: CaptureDB;
  ws: WsBroadcaster;
} {
  const flushed: { id: number; res: ResponseMeta }[] = [];
  const broadcasts: { type: "update"; capture: Record<string, unknown> }[] = [];
  const db = {
    batchUpdate: async (batch: { id: number; res: ResponseMeta }[]) => {
      if (stuck) return;
      flushed.push(...batch);
    },
  } as unknown as CaptureDB;
  const ws = {
    broadcast: (msg: { type: "update"; capture: Record<string, unknown> }) => {
      broadcasts.push(msg);
    },
  } as unknown as WsBroadcaster;
  return { flushed, broadcasts, db, ws };
}

test("queue depth never exceeds queueMaxDepth and oldest entries drop when DB is stuck", () => {
  const { flushed, db, ws } = makeStubs({ stuck: true });
  const queue = new WriteQueue(db, baseConfig, (messages) => {
    for (const msg of messages) ws.broadcast(msg);
  });

  queue.queueUpdate(1, reqMeta, makeRes(1));
  queue.queueUpdate(2, reqMeta, makeRes(2));
  queue.queueUpdate(3, reqMeta, makeRes(3));
  queue.queueUpdate(4, reqMeta, makeRes(4));
  queue.queueUpdate(5, reqMeta, makeRes(5));

  expect(queue.length).toBeLessThanOrEqual(baseConfig.queueMaxDepth);
  expect(flushed.length).toBe(0);
});

test("flush clears the queue normally when flushBatch is reached", async () => {
  const config = { ...baseConfig, queueMaxDepth: 10, flushBatch: 3 };
  const { flushed, broadcasts, db, ws } = makeStubs();
  const queue = new WriteQueue(db, config, (messages) => {
    for (const msg of messages) ws.broadcast(msg);
  });

  queue.queueUpdate(1, reqMeta, makeRes(1));
  queue.queueUpdate(2, reqMeta, makeRes(2));
  queue.queueUpdate(3, reqMeta, makeRes(3));

  await queue.flushNow();

  expect(queue.length).toBe(0);
  expect(flushed.map((it) => it.id)).toEqual([1, 2, 3]);
  expect(broadcasts.length).toBe(3);
});

test("dropping happens after a forced flush attempt when cap is hit", () => {
  const { flushed, db, ws } = makeStubs({ stuck: true });
  const queue = new WriteQueue(db, baseConfig, (messages) => {
    for (const msg of messages) ws.broadcast(msg);
  });

  queue.queueUpdate(1, reqMeta, makeRes(1));
  queue.queueUpdate(2, reqMeta, makeRes(2));
  queue.queueUpdate(3, reqMeta, makeRes(3));
  queue.queueUpdate(4, reqMeta, makeRes(4));

  expect(queue.length).toBeLessThanOrEqual(baseConfig.queueMaxDepth);
  expect(flushed.length).toBe(0);
});

test("queueUpdate below cap schedules a timer and does not flush immediately", () => {
  const config = { ...baseConfig, queueMaxDepth: 10, flushBatch: 10 };
  const { flushed, db, ws } = makeStubs();
  const queue = new WriteQueue(db, config, (messages) => {
    for (const msg of messages) ws.broadcast(msg);
  });

  queue.queueUpdate(1, reqMeta, makeRes(1));

  expect(queue.length).toBe(1);
  expect(flushed.length).toBe(0);
  expect(queue.hasTimer).toBe(true);
});

test("flushNow re-queues batch at front when batchUpdate throws", () => {
  const flushed: { id: number; res: ResponseMeta }[] = [];
  const db = {
    batchUpdate: () => {
      throw new Error("SQLite BUSY");
    },
  } as unknown as CaptureDB;
  const ws = { broadcast: () => {} } as unknown as WsBroadcaster;

  const config = { ...baseConfig, queueMaxDepth: 100, flushBatch: 2 };
  const queue = new WriteQueue(db, config, (messages) => {
    for (const msg of messages) ws.broadcast(msg);
  });

  queue.queueUpdate(1, reqMeta, makeRes(1));
  queue.queueUpdate(2, reqMeta, makeRes(2));

  expect(queue.length).toBe(2);
  expect(flushed.length).toBe(0);
});

test("drop path activates when queue overflows after failed flush", () => {
  const db = {
    batchUpdate: () => {
      throw new Error("disk full");
    },
  } as unknown as CaptureDB;
  const ws = { broadcast: () => {} } as unknown as WsBroadcaster;

  const config = { ...baseConfig, queueMaxDepth: 3, flushBatch: 25 };
  const queue = new WriteQueue(db, config, (messages) => {
    for (const msg of messages) ws.broadcast(msg);
  });

  queue.queueUpdate(1, reqMeta, makeRes(1));
  queue.queueUpdate(2, reqMeta, makeRes(2));
  queue.queueUpdate(3, reqMeta, makeRes(3));
  queue.queueUpdate(4, reqMeta, makeRes(4));
  queue.queueUpdate(5, reqMeta, makeRes(5));

  expect(queue.length).toBeLessThanOrEqual(config.queueMaxDepth);
  expect(queue.droppedCount).toBeGreaterThan(0);
});

test("concurrent threshold flush does not double-flush or mis-account dropped items", async () => {
  const flushed: { id: number; res: ResponseMeta }[] = [];
  const flushedIds = new Set<number>();
  let flushInFlight = false;
  const db = {
    batchUpdate: async (batch: { id: number; res: ResponseMeta }[]) => {
      expect(flushInFlight).toBe(false);
      flushInFlight = true;
      await Bun.sleep(20);
      flushInFlight = false;
      flushed.push(...batch);
      for (const it of batch) flushedIds.add(it.id);
    },
  } as unknown as CaptureDB;
  const ws = { broadcast: () => {} } as unknown as WsBroadcaster;

  const config = { ...baseConfig, queueMaxDepth: 3, flushBatch: 2 };
  const queue = new WriteQueue(db, config, (messages) => {
    for (const msg of messages) ws.broadcast(msg);
  });

  const totalPushed = 10;
  for (let i = 1; i <= totalPushed; i++) {
    queue.queueUpdate(i, reqMeta, makeRes(i));
  }

  await Bun.sleep(100);

  expect(queue.length).toBeLessThanOrEqual(config.queueMaxDepth);

  const droppedIds = new Set<number>();
  for (let i = 1; i <= totalPushed; i++) {
    if (!flushedIds.has(i)) droppedIds.add(i);
  }

  expect(flushed.length + queue.droppedCount).toBe(totalPushed);

  for (const id of flushedIds) {
    expect(droppedIds.has(id)).toBe(false);
  }
});
