// Public API — createProxyServer() factory.
// Exports the main server creation function and key types for programmatic use.

import { printBanner } from "./banner.js";
import {
  type RawConfig,
  type ReloadResult,
  applyReloadToConfig,
  loadConfig,
  readConfigFile,
  resolveConfigPath,
  saveConfig,
} from "./config.js";
import { CaptureDB } from "./db.js";
import { syncPricing } from "./economics.js";
import { computeRequestWeight } from "./helpers.js";
import { ConcurrencyGate, GATE_RECONFIG_FIELDS, gateOptionsFromConfig } from "./limiter/index.js";
import { createLogger } from "./logger.js";
import { metrics } from "./metrics.js";
import { ModelsClient } from "./models.js";
import { type RateLimiterRef, createProxyHandler } from "./proxy.js";
import { WriteQueue } from "./queue.js";
import type { CaptureStore } from "./queue.js";
import { SlidingWindowRateLimiter } from "./rate.js";
import type { ProxyConfig } from "./types.js";
import { UmansUsageClient } from "./usage.js";
import { createViewerRouter } from "./viewer.js";
import { DescriptionCache } from "./vision/cache.js";
import type { VisionLookup } from "./vision/detect.js";
import { VisionHandoff } from "./vision/handoff.js";
import { PersistentDescriptionStore } from "./vision/persistent-cache.js";
import { CompositeVisionSink, DbVisionSink, WsBroadcastVisionSink } from "./vision/sink.js";
import { ConnectionWarmer } from "./warmer.js";
import { WorkerCaptureStore } from "./workers/worker-store.js";
import { type BunServerWebSocket, WsBroadcaster } from "./ws.js";

const log = createLogger("server");

export { loadConfig, readConfigFile, saveConfig, validateConfig } from "./config.js";
export { resolveConfigDir, resolveConfigPath, ensureConfigFile } from "./config.js";
export type { RawConfig, RawConfigInput, ValidationResult, ReloadResult } from "./config.js";
export { CaptureDB } from "./db.js";
export { WsBroadcaster } from "./ws.js";
export type { BunServerWebSocket } from "./ws.js";
export { WriteQueue } from "./queue.js";
export { stampCacheTtl } from "./stamp.js";
export { ConnectionWarmer } from "./warmer.js";
export { ConcurrencyGate } from "./limiter/index.js";
export { SlidingWindowRateLimiter } from "./rate.js";
export { UmansUsageClient } from "./usage.js";
export type {
  ProxyConfig,
  CaptureConfig,
  CaptureRow,
  CaptureSummary,
  GateConfig,
  ProtocolConfig,
  QueueConfig,
  StampConfig,
  WsMessage,
  GateStats,
  UsageSnapshot,
  BreakerState,
} from "./types.js";
export type { TimedChunk } from "./usage-extract.js";

/** Whitelist of LLM API routes that the proxy will capture + forward.
 * Matches umans API surface (verified from app.umans.ai/offers/code/docs). */
const LLM_ROUTES = new Set([
  "POST /v1/messages",
  "GET /v1/models",
  "GET /v1/models/info",
  "POST /v1/chat/completions",
]);

/** Options for {@link createRequestDispatcher}. */
interface RequestDispatcherOptions {
  handleViewer: (url: URL, req: Request) => Promise<Response | null>;
  handleProxy: (req: Request, url: URL) => Promise<Response>;
  handleHealth: () => Response;
  handleMetrics: () => Response;
  viewerPrefix: string;
}

/**
 * Create the request dispatcher that routes incoming requests to:
 * 1. WebSocket upgrade (returns 101 on success, 400 on failure)
 * 2. Viewer routes (dashboard + REST API under the viewer prefix)
 * 3. Health check endpoint (`GET /health`)
 * 4. Metrics endpoint (`GET /metrics`)
 * 5. LLM proxy routes (whitelisted method+path combinations)
 * 6. 404 fallback for non-LLM paths
 */
function createRequestDispatcher(options: RequestDispatcherOptions) {
  const { handleViewer, handleProxy, handleHealth, handleMetrics, viewerPrefix: VIEWER } = options;

  return async (req: Request, server: Bun.Server<undefined>): Promise<Response> => {
    const url = new URL(req.url);

    // WebSocket upgrade
    if (url.pathname === `${VIEWER}/ws`) {
      if (server.upgrade(req)) return new Response(null, { status: 101 });
      return new Response("upgrade failed", { status: 400 });
    }

    // Viewer routes (dashboard + REST API)
    if (url.pathname === VIEWER || url.pathname.startsWith(`${VIEWER}/`)) {
      const resp = await handleViewer(url, req);
      return resp ?? new Response("not found", { status: 404 });
    }

    // Health check endpoint
    if (url.pathname === "/health" && req.method === "GET") {
      return handleHealth();
    }

    // Metrics endpoint (Prometheus text format)
    if (url.pathname === "/metrics" && req.method === "GET") {
      return handleMetrics();
    }

    // Reject non-LLM paths (favicon, preflight, health checks, etc.)
    const routeKey = `${req.method} ${url.pathname}`;
    if (!LLM_ROUTES.has(routeKey)) {
      return new Response(JSON.stringify({ error: "not_an_llm_endpoint", path: url.pathname }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }

    // Proxy route — disable idle timeout for long streaming responses
    server.timeout(req, 0);
    return handleProxy(req, url);
  };
}

const DEFAULT_RATE_WINDOW_SECONDS = 18000;

function createRateLimiter(
  rateLimitRequests: number,
  snap: { requestsHardCap: number | null; requestsWindowSeconds: number | null } | null,
): SlidingWindowRateLimiter | null {
  if (rateLimitRequests === -1) return null;
  if (rateLimitRequests > 0) {
    const windowSeconds = snap?.requestsWindowSeconds ?? DEFAULT_RATE_WINDOW_SECONDS;
    return new SlidingWindowRateLimiter({ limit: rateLimitRequests, windowSeconds });
  }
  // rateLimitRequests === 0: auto-derive from usage snapshot
  if (snap && snap.requestsHardCap !== null && snap.requestsHardCap > 0) {
    const windowSeconds = snap.requestsWindowSeconds ?? DEFAULT_RATE_WINDOW_SECONDS;
    return new SlidingWindowRateLimiter({ limit: snap.requestsHardCap, windowSeconds });
  }
  return null;
}

/** Options for creating a proxy server. */
export interface CreateProxyServerOptions {
  /** Override env config. Pass a partial config to merge with defaults.
   *  Note: `host` is hardcoded to `127.0.0.1` and cannot be overridden. */
  config?: Omit<Partial<ProxyConfig>, "host">;
  /** Use an existing CaptureDB instance instead of creating one. */
  db?: CaptureDB;
  /** Use an existing WsBroadcaster instead of creating one. */
  ws?: WsBroadcaster;
  /** Print the startup banner (default: true). */
  banner?: boolean;
}

/** The running proxy server handle. */
export interface ProxyServer {
  server: ReturnType<typeof Bun.serve>;
  db: CaptureDB;
  ws: WsBroadcaster;
  queue: WriteQueue;
  warmer: ConnectionWarmer | null;
  gate: ConcurrencyGate;
  usage: UmansUsageClient;
  models: ModelsClient;
  rate: SlidingWindowRateLimiter | null;
  config: ProxyConfig;
  /** Reload config from disk and apply hot-reloadable fields. */
  reloadConfig(): ReloadResult;
  shutdown(): Promise<void>;
}

/**
 * Create and start the LLM capture proxy server.
 *
 * This is the main programmatic entry point. It sets up the database,
 * WebSocket broadcaster, write-behind queue, viewer router, and proxy handler,
 * then starts listening on the configured port.
 */
export function createProxyServer(options: CreateProxyServerOptions = {}): ProxyServer {
  const envConfig = loadConfig();
  const config: ProxyConfig = { ...envConfig, ...options.config, host: "127.0.0.1" };

  const db = options.db ?? new CaptureDB(config);
  const ws = options.ws ?? new WsBroadcaster();
  const writeStore: CaptureStore = config.useWriteWorker
    ? new WorkerCaptureStore(config.dbPath, config.compressionEnabled)
    : db;
  const queue = new WriteQueue(writeStore, config, (messages) => {
    for (const msg of messages) {
      ws.broadcast(msg);
    }
  });
  const warmer = config.warmerEnabled ? new ConnectionWarmer(config) : null;

  const usage = new UmansUsageClient(config);
  const models = new ModelsClient({
    target: config.target,
    apiKey: config.umansApiKey,
    refreshMs: config.modelsRefreshMs,
  });
  models.start();
  models.onChange(() => {
    try {
      syncPricing(db.rawDb, models.list());
    } catch (err) {
      log.error("pricing sync failed", { error: err instanceof Error ? err.message : String(err) });
    }
  });
  try {
    syncPricing(db.rawDb, models.list());
  } catch {
    // Models not fetched yet — onChange will sync after first poll.
  }
  const gate = new ConcurrencyGate(gateOptionsFromConfig(config));
  const rateRef: RateLimiterRef = { current: createRateLimiter(config.rateLimitRequests, null) };

  usage.onChange((snap) => {
    gate.setSoftLimit(snap.concurrencySoftLimit);
    let effective = snap.concurrencySoftLimit;
    if (snap.priorityLow) effective = Math.max(1, effective - 1);
    const boxed = snap.boxedUntil !== null && snap.boxedUntil > Date.now();
    if (boxed && snap.boxedReason !== "rate_limited") {
      gate.resize(1);
    } else {
      gate.resize(effective);
    }
    // Auto-derive rate limiter from usage snapshot when rate_limit_requests=0
    if (config.rateLimitRequests === 0 && snap.requestsHardCap !== null) {
      if (rateRef.current === null) {
        rateRef.current = createRateLimiter(0, snap);
      }
    } else if (config.rateLimitRequests > 0 && snap.requestsWindowSeconds !== null) {
      if (rateRef.current === null) {
        rateRef.current = createRateLimiter(config.rateLimitRequests, snap);
      }
    }
    ws.broadcast({ type: "gate", stats: gate.getStats(snap) });
  });
  gate.onStatsChange(() => {
    ws.broadcast({ type: "gate", stats: gate.getStats(usage.getSnapshot()) });
  });
  usage.start();

  function applyLimitsFromSource(
    source: { hardCap: number; softLimit: number },
    persist = false,
  ): void {
    if (persist) {
      saveConfig({
        concurrency_hard_cap: source.hardCap,
        concurrency_soft_limit: source.softLimit,
      });
    }
    config.concurrencyHardCap = source.hardCap;
    config.concurrencySoftLimit = source.softLimit;
    gate.setHardCap(source.hardCap);
    gate.setSoftLimit(source.softLimit);
    ws.broadcast({ type: "gate", stats: gate.getStats(usage.getSnapshot()) });
  }

  const persistentStore = config.visionPersistentCache
    ? new PersistentDescriptionStore(
        db,
        config.visionCacheTtlMs,
        config.visionCacheMaxRows,
        config.visionPendingMaxBatch,
      )
    : null;
  const visionCache = new DescriptionCache(
    config.visionCacheSize,
    config.visionCacheTtlMs,
    persistentStore,
  );

  const catalog: VisionLookup | null = config.visionStrategy !== "never" ? models : null;

  const visionModelName = config.visionModel ?? "";
  const visionWeight = computeRequestWeight(visionModelName, models);

  const visionSink = new CompositeVisionSink([
    new DbVisionSink(db, config),
    new WsBroadcastVisionSink(ws, config),
  ]);
  const vision =
    config.visionStrategy !== "never"
      ? new VisionHandoff(
          {
            strategy: config.visionStrategy,
            target: config.visionTarget,
            model: config.visionModel,
            prompt: config.visionPrompt,
            promptVersion: config.visionPromptVersion,
            maxImages: config.visionMaxImages,
            maxDescriptionTokens: config.visionMaxDescriptionTokens,
            reasoningEffort: config.visionReasoningEffort,
            timeoutMs: config.visionTimeoutMs,
            cacheSize: config.visionCacheSize,
            cacheTtlMs: config.visionCacheTtlMs,
            cacheMaxRows: config.visionCacheMaxRows,
            persistentCache: config.visionPersistentCache,
            concurrency: config.visionConcurrency,
            apiKey: config.umansApiKey || null,
            forceInterceptCapable: config.visionForceInterceptCapable,
            maxDimension: config.visionMaxDimension,
            jpegQuality: config.visionJpegQuality,
            imageFormat: config.visionImageFormat,
            imageDetail: config.visionImageDetail,
            visionWeight,
            backgroundVision: config.backgroundVision,
          },
          visionCache,
          catalog,
          gate,
          db,
          visionSink,
          config,
        )
      : null;

  if (persistentStore && config.visionPersistentCache) {
    const warmed = persistentStore.warmIntoCache(
      (key, description) => visionCache.warm(key, description),
      config.visionCacheSize,
    );
    if (warmed > 0) {
      console.log(`[vision] Warmed ${warmed} descriptions from persistent store`);
    }
  }

  const { handleProxy } = createProxyHandler(
    db,
    ws,
    queue,
    config,
    gate,
    rateRef,
    vision,
    models,
    () => warmer?.notifyTraffic(),
  );
  let lastRawConfig: RawConfig = readConfigFile();

  const reloadConfig = (): ReloadResult => {
    const oldRaw = lastRawConfig;
    const newRaw = readConfigFile();
    const fresh = loadConfig();
    const { applied, restartRequired } = applyReloadToConfig(config, fresh, oldRaw, newRaw);
    lastRawConfig = newRaw;

    if (applied.some((k) => GATE_RECONFIG_FIELDS.has(k as keyof ProxyConfig))) {
      gate.reconfigure(gateOptionsFromConfig(config));
    }

    if (applied.includes("concurrency_hard_cap")) {
      gate.setHardCap(config.concurrencyHardCap);
    }
    if (applied.includes("concurrency_soft_limit")) {
      gate.setSoftLimit(config.concurrencySoftLimit);
    }

    if (applied.includes("compression_enabled")) {
      db.compressionEnabled = config.compressionEnabled;
    }

    if (applied.includes("rate_limit_requests")) {
      rateRef.current = createRateLimiter(config.rateLimitRequests, usage.getSnapshot());
    }

    ws.broadcast({ type: "gate", stats: gate.getStats(usage.getSnapshot()) });

    return {
      ok: true,
      errors: [],
      warnings: [],
      applied,
      restartRequired,
      configPath: resolveConfigPath(),
    };
  };

  const refreshLimits = async (): Promise<
    | {
        ok: true;
        hardCap: number;
        softLimit: number;
        requestsLimit: number | null;
        requestsHardCap: number | null;
        requestsWindowSeconds: number | null;
      }
    | { ok: false; error: string }
  > => {
    const r = await usage.fetchLimitsFromSource();
    if (r.ok) {
      applyLimitsFromSource({ hardCap: r.hardCap, softLimit: r.softLimit }, true);
      const rl = await usage.fetchRequestsLimit();
      if (rl.ok) {
        const snap = usage.getSnapshot();
        if (config.rateLimitRequests === 0 && rl.hardCap !== null && rl.hardCap > 0) {
          rateRef.current = createRateLimiter(0, {
            requestsHardCap: rl.hardCap,
            requestsWindowSeconds: rl.windowSeconds,
          });
        } else if (config.rateLimitRequests > 0 && rl.windowSeconds !== null) {
          rateRef.current = createRateLimiter(config.rateLimitRequests, {
            requestsHardCap: rl.hardCap,
            requestsWindowSeconds: rl.windowSeconds,
          });
        } else if (config.rateLimitRequests === 0 && rl.hardCap === null) {
          // Upstream reports unlimited (e.g. Code Max) — persist -1 so the
          // config UI reflects the effective state instead of staying at 0.
          saveConfig({ rate_limit_requests: -1 });
          config.rateLimitRequests = -1;
          rateRef.current = null;
        }
        ws.broadcast({ type: "gate", stats: gate.getStats(snap) });
        return {
          ok: true,
          hardCap: r.hardCap,
          softLimit: r.softLimit,
          requestsLimit: rl.limit,
          requestsHardCap: rl.hardCap,
          requestsWindowSeconds: rl.windowSeconds,
        };
      }
      return {
        ok: true,
        hardCap: r.hardCap,
        softLimit: r.softLimit,
        requestsLimit: null,
        requestsHardCap: null,
        requestsWindowSeconds: null,
      };
    }
    return r;
  };

  if (config.umansApiKey && config.concurrencyHardCap <= 1) {
    void refreshLimits();
  }

  const { handleViewer, VIEWER } = createViewerRouter({
    db,
    ws,
    config,
    gate,
    usage,
    vision,
    models,
    reloadConfig,
    refreshLimits,
    restart: () => {
      shutdown().finally(() => process.exit(0));
    },
  });

  const handleHealth = (): Response => {
    const stats = gate.getStats(usage.getSnapshot());
    return new Response(
      JSON.stringify({
        status: "ok",
        uptime: process.uptime(),
        pendingRequests: server.pendingRequests,
        pendingWebSockets: server.pendingWebSockets,
        gateActive: stats.active,
        gateLimit: stats.softLimit,
        queueDepth: queue.length,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const handleMetrics = (): Response => {
    const stats = gate.getStats(usage.getSnapshot());
    metrics.set("umans_gate_uptime_seconds", process.uptime(), "Process uptime in seconds");
    metrics.set("umans_gate_pending_requests", server.pendingRequests, "In-flight HTTP requests");
    metrics.set(
      "umans_gate_pending_websockets",
      server.pendingWebSockets,
      "Connected WebSocket clients",
    );
    metrics.set("umans_gate_gate_active", stats.active, "Active concurrency permits");
    metrics.set("umans_gate_gate_limit", stats.softLimit, "Concurrency soft limit");
    metrics.set("umans_gate_queue_depth", queue.length, "Write queue depth");
    return new Response(metrics.format(), {
      status: 200,
      headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
    });
  };

  const fetch = createRequestDispatcher({
    handleViewer,
    handleProxy,
    handleHealth,
    handleMetrics,
    viewerPrefix: VIEWER,
  });

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    reusePort: true,
    idleTimeout: config.idleTimeout,
    fetch,
    error(err): Response {
      log.error("uncaught server error", {
        message: err.message,
        stack: err.stack,
      });
      return new Response(
        JSON.stringify({ error: "internal_error", message: "Internal proxy error" }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    },
    websocket: {
      open(socket) {
        ws.add(socket as unknown as BunServerWebSocket);
      },
      message() {},
      close(socket) {
        ws.remove(socket as unknown as BunServerWebSocket);
      },
      backpressureLimit: config.wsBackpressureLimit > 0 ? config.wsBackpressureLimit : undefined,
      closeOnBackpressureLimit: config.wsCloseOnBackpressureLimit,
    },
  });

  if (options.banner !== false) {
    printBanner(config);
  }

  warmer?.start();

  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info("graceful shutdown: draining in-flight requests...");

    warmer?.stop();
    models.stop();
    usage.stop();

    server.stop(false);

    const drainDeadline = Date.now() + 5000;
    while (server.pendingRequests > 0 && Date.now() < drainDeadline) {
      await Bun.sleep(100);
    }
    if (server.pendingRequests > 0) {
      log.warn(`drain timeout: ${server.pendingRequests} requests still in-flight`);
    }

    gate.shutdown();
    await queue.flushNow();
    if (writeStore instanceof WorkerCaptureStore) {
      await writeStore.close();
    }
    db.close();

    process.removeListener("SIGINT", sigHandler);
    process.removeListener("SIGTERM", sigHandler);
  };

  const sigHandler = () => {
    shutdown().finally(() => process.exit(0));
  };

  process.once("SIGINT", sigHandler);
  process.once("SIGTERM", sigHandler);

  process.on("unhandledRejection", (reason) => {
    log.error("unhandledRejection", { reason: String(reason) });
  });
  process.on("uncaughtException", (err) => {
    log.error("uncaughtException", { message: err.message, stack: err.stack });
  });

  return {
    server,
    db,
    ws,
    queue,
    warmer,
    gate,
    usage,
    models,
    rate: rateRef.current,
    config,
    reloadConfig,
    shutdown,
  };
}
