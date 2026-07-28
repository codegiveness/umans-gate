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
  queueMaxDepth: 100,
  idleTimeout: 255,
  upstreamProtocol: "http1.1",
  incomingProtocol: "http1.1",
  stampClaudeCode: false,
  stampGlm52Thinking: false,
  stampKimiK27CodeThinking: false,
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
  experimentRewriteIds: false,
  experimentRewriteTtlMs: 3600000,
  experimentStripOmoReminder: false,
  experimentTtftWatchdog: false,
  ttftTimeoutMs: 60000,
  ttftRetryMaxAttempts: 2,
  ttftRetryGateSaturationPct: 80,
  ttftRetryCooldownMs: 30000,
  ttftWatchdogMultiplier: 5,
  ttftWatchdogHardCapMs: 300000,
  performanceSampleCount: 200,
  incidentRetentionDays: 30,
  usageHistoryEnabled: true,
  usageRawRetentionDays: 7,
  usageGapThresholdMinutes: 60,
  usageIdleSessionTimeoutMinutes: 5,
  visionIntentStrategy: "auto",
  visionDecompositionEnabled: true,
  visionDecompositionTimeoutMs: 3000,
  visionCraftingTimeoutMs: 3000,
  visionAdjacentTextMaxChars: 500,
  visionRecentMessagesCount: 6,
  visionSystemPromptMaxChars: 1000,
  useHardCap: false,
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

test("flushNow enriches WS broadcast with p50 from DB (getUpstreamP50)", async () => {
  const broadcasts: WsMessage[] = [];
  const db = {
    batchUpdate: async () => {},
    getUpstreamP50: (id: number) =>
      id === 1
        ? { upstream_ttft_p50_ms: 500, upstream_tps_p50: 42 }
        : { upstream_ttft_p50_ms: 300, upstream_tps_p50: 55 },
  } as unknown as CaptureDB;
  const ws = { broadcast: (msg: WsMessage) => broadcasts.push(msg) } as unknown as WsBroadcaster;

  const queue = new WriteQueue(db, baseConfig, (messages) => {
    for (const msg of messages) ws.broadcast(msg);
  });

  queue.queueUpdate(1, reqMeta, makeRes(1));
  queue.queueUpdate(2, reqMeta, makeRes(2));
  await queue.flushNow();

  expect(broadcasts.length).toBe(2);
  expect(broadcasts[0].type).toBe("update");
  if (broadcasts[0].type === "update") {
    expect(broadcasts[0].capture.upstream_ttft_p50_ms).toBe(500);
    expect(broadcasts[0].capture.upstream_tps_p50).toBe(42);
  }
  if (broadcasts[1].type === "update") {
    expect(broadcasts[1].capture.upstream_ttft_p50_ms).toBe(300);
    expect(broadcasts[1].capture.upstream_tps_p50).toBe(55);
  }
});

test("flushNow falls back to res.$upstream_ttft_p50_ms when getUpstreamP50 is not available", async () => {
  const broadcasts: WsMessage[] = [];
  const db = {
    batchUpdate: async () => {},
  } as unknown as CaptureDB;
  const ws = { broadcast: (msg: WsMessage) => broadcasts.push(msg) } as unknown as WsBroadcaster;

  const queue = new WriteQueue(db, baseConfig, (messages) => {
    for (const msg of messages) ws.broadcast(msg);
  });

  const res = makeRes(1);
  res.$upstream_ttft_p50_ms = 777;
  res.$upstream_tps_p50 = 33;
  queue.queueUpdate(1, reqMeta, res);
  await queue.flushNow();

  expect(broadcasts.length).toBe(1);
  if (broadcasts[0].type === "update") {
    expect(broadcasts[0].capture.upstream_ttft_p50_ms).toBe(777);
    expect(broadcasts[0].capture.upstream_tps_p50).toBe(33);
  }
});

test("flushNow handles getUpstreamP50 returning null (pruned row)", async () => {
  const broadcasts: WsMessage[] = [];
  const db = {
    batchUpdate: async () => {},
    getUpstreamP50: () => null,
  } as unknown as CaptureDB;
  const ws = { broadcast: (msg: WsMessage) => broadcasts.push(msg) } as unknown as WsBroadcaster;

  const queue = new WriteQueue(db, baseConfig, (messages) => {
    for (const msg of messages) ws.broadcast(msg);
  });

  queue.queueUpdate(1, reqMeta, makeRes(1));
  await queue.flushNow();

  expect(broadcasts.length).toBe(1);
  if (broadcasts[0].type === "update") {
    expect(broadcasts[0].capture.upstream_ttft_p50_ms).toBeNull();
    expect(broadcasts[0].capture.upstream_tps_p50).toBeNull();
  }
});
