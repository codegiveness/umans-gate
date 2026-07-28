import { expect, test } from "bun:test";
import type { CaptureDB } from "../../src/db.js";
import { WriteQueue } from "../../src/queue.js";
import type { ProxyConfig, RequestMeta, ResponseMeta, WsMessage } from "../../src/types.js";
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

test("onDrop marks dropped entry as failed and broadcasts state message", () => {
  const setStateCalls: Array<{ id: number; state: string }> = [];
  const broadcasts: WsMessage[] = [];

  const db = {
    batchUpdate: () => {
      throw new Error("disk full");
    },
    setState: (id: number, state: string) => {
      setStateCalls.push({ id, state });
    },
  } as unknown as CaptureDB;

  const ws = {
    broadcast: (msg: WsMessage) => {
      broadcasts.push(msg);
    },
  } as unknown as WsBroadcaster;

  const config = { ...baseConfig, queueMaxDepth: 3, flushBatch: 25 };
  const queue = new WriteQueue(db, config, undefined, (dropped) => {
    db.setState(dropped.id, "failed");
    ws.broadcast({ type: "state", captureId: dropped.id, state: "failed" });
  });

  queue.queueUpdate(1, reqMeta, makeRes(1));
  queue.queueUpdate(2, reqMeta, makeRes(2));
  queue.queueUpdate(3, reqMeta, makeRes(3));
  queue.queueUpdate(4, reqMeta, makeRes(4));
  queue.queueUpdate(5, reqMeta, makeRes(5));

  // (4) droppedCount is incremented
  expect(queue.droppedCount).toBeGreaterThan(0);

  // (1) oldest entries were dropped (ids 1, 2, 3)
  const failedIds = setStateCalls.filter((s) => s.state === "failed").map((s) => s.id);
  expect(failedIds).toContain(1);
  expect(failedIds).toContain(2);
  expect(failedIds).toContain(3);

  // (2) dropped entry's capture row reaches "failed" state via setState
  for (const call of setStateCalls) {
    expect(call.state).toBe("failed");
  }

  // (3) a WS state message {type: "state", captureId, state: "failed"} is broadcast
  const stateMsgs = broadcasts.filter(
    (m): m is { type: "state"; captureId: number; state: string } =>
      m.type === "state" && m.state === "failed",
  );
  expect(stateMsgs.length).toBeGreaterThan(0);
  const stateMsgIds = stateMsgs.map((m) => m.captureId);
  expect(stateMsgIds).toContain(1);
  expect(stateMsgIds).toContain(2);
  expect(stateMsgIds).toContain(3);
});

test("onDrop is optional — queue works without it (backward compat)", () => {
  const db = {
    batchUpdate: () => {
      throw new Error("disk full");
    },
  } as unknown as CaptureDB;

  const config = { ...baseConfig, queueMaxDepth: 3, flushBatch: 25 };
  const queue = new WriteQueue(db, config);

  queue.queueUpdate(1, reqMeta, makeRes(1));
  queue.queueUpdate(2, reqMeta, makeRes(2));
  queue.queueUpdate(3, reqMeta, makeRes(3));
  queue.queueUpdate(4, reqMeta, makeRes(4));
  queue.queueUpdate(5, reqMeta, makeRes(5));

  expect(queue.droppedCount).toBeGreaterThan(0);
});

test("onDrop receives the dropped entry (oldest first)", () => {
  const droppedIds: number[] = [];

  const db = {
    batchUpdate: () => {
      throw new Error("disk full");
    },
  } as unknown as CaptureDB;

  const config = { ...baseConfig, queueMaxDepth: 3, flushBatch: 25 };
  const queue = new WriteQueue(db, config, undefined, (dropped) => {
    droppedIds.push(dropped.id);
  });

  queue.queueUpdate(1, reqMeta, makeRes(1));
  queue.queueUpdate(2, reqMeta, makeRes(2));
  queue.queueUpdate(3, reqMeta, makeRes(3));
  queue.queueUpdate(4, reqMeta, makeRes(4));
  queue.queueUpdate(5, reqMeta, makeRes(5));

  // Oldest entries dropped first: 1, 2, 3
  expect(droppedIds).toEqual([1, 2, 3]);
  expect(queue.droppedCount).toBe(3);
});
