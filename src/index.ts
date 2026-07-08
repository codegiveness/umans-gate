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
import { computeRequestWeight } from "./helpers.js";
import { ConcurrencyGate, GATE_RECONFIG_FIELDS, gateOptionsFromConfig } from "./limiter.js";
import { ModelsClient } from "./models.js";
import { createProxyHandler } from "./proxy.js";
import { WriteQueue } from "./queue.js";
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
import { type BunServerWebSocket, WsBroadcaster } from "./ws.js";

export { loadConfig, readConfigFile, saveConfig, validateConfig } from "./config.js";
export { resolveConfigDir, resolveConfigPath, ensureConfigFile } from "./config.js";
export type { RawConfig, RawConfigInput, ValidationResult, ReloadResult } from "./config.js";
export { CaptureDB } from "./db.js";
export { WsBroadcaster } from "./ws.js";
export type { BunServerWebSocket } from "./ws.js";
export { WriteQueue } from "./queue.js";
export { stampCacheTtl } from "./stamp.js";
export { ConnectionWarmer } from "./warmer.js";
export { ConcurrencyGate } from "./limiter.js";
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
  viewerPrefix: string;
}

/**
 * Create the request dispatcher that routes incoming requests to:
 * 1. WebSocket upgrade (returns 101 on success, 400 on failure)
 * 2. Viewer routes (dashboard + REST API under the viewer prefix)
 * 3. LLM proxy routes (whitelisted method+path combinations)
 * 4. 404 fallback for non-LLM paths
 */
function createRequestDispatcher(options: RequestDispatcherOptions) {
  const { handleViewer, handleProxy, viewerPrefix: VIEWER } = options;

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

/** Options for creating a proxy server. */
export interface CreateProxyServerOptions {
  /** Override env config. Pass a partial config to merge with defaults. */
  config?: Partial<ProxyConfig>;
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
  shutdown(): void;
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
  const config: ProxyConfig = { ...envConfig, ...options.config };

  const db = options.db ?? new CaptureDB(config);
  const ws = options.ws ?? new WsBroadcaster();
  const queue = new WriteQueue(db, ws, config);
  const warmer = config.warmerEnabled ? new ConnectionWarmer(config) : null;

  const usage = new UmansUsageClient(config);
  const models = new ModelsClient({
    target: config.target,
    apiKey: config.umansApiKey,
    refreshMs: config.modelsRefreshMs,
  });
  models.start();
  const gate = new ConcurrencyGate(gateOptionsFromConfig(config));
  let rate =
    config.rateLimitRequests > 0
      ? new SlidingWindowRateLimiter({
          limit: config.rateLimitRequests,
          windowSeconds: 18000,
        })
      : null;

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
    if (config.rateLimitRequests > 0 && snap.requestsWindowSeconds !== null) {
      const needRecreate = rate === null || rate.peek().retryAfterSeconds !== null;
      if (needRecreate) {
        rate = new SlidingWindowRateLimiter({
          limit: config.rateLimitRequests,
          windowSeconds: snap.requestsWindowSeconds,
        });
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

  // Bootstrap: if persisted hard_cap is still default (1), fetch once from source and persist.
  if (config.umansApiKey && config.concurrencyHardCap <= 1) {
    void (async () => {
      const r = await usage.fetchLimitsFromSource();
      if (r.ok && r.hardCap > 1) {
        applyLimitsFromSource({ hardCap: r.hardCap, softLimit: r.softLimit }, true);
      }
    })();
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
  const visionWeight = computeRequestWeight(config, visionModelName, models);

  const visionSink = new CompositeVisionSink([new DbVisionSink(db), new WsBroadcastVisionSink(ws)]);
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
            apiKey: config.visionApiKey || config.umansApiKey || null,
            forceInterceptCapable: config.visionForceInterceptCapable,
            maxDimension: config.visionMaxDimension,
            jpegQuality: config.visionJpegQuality,
            imageFormat: config.visionImageFormat,
            imageDetail: config.visionImageDetail,
            visionWeight,
          },
          visionCache,
          catalog,
          gate,
          db,
          visionSink,
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
    rate,
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
    { ok: true; hardCap: number; softLimit: number } | { ok: false; error: string }
  > => {
    const r = await usage.fetchLimitsFromSource();
    if (r.ok) {
      applyLimitsFromSource({ hardCap: r.hardCap, softLimit: r.softLimit }, true);
    }
    return r;
  };

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
      shutdown();
      process.exit(0);
    },
  });

  const fetch = createRequestDispatcher({
    handleViewer,
    handleProxy,
    viewerPrefix: VIEWER,
  });

  const server = Bun.serve({
    port: config.port,
    hostname: config.host,
    reusePort: true,
    idleTimeout: config.idleTimeout,
    fetch,
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

  const shutdown = () => {
    warmer?.stop();
    models.stop();
    usage.stop();
    gate.shutdown();
    queue.flushNow();
    db.close();
    server.stop();
    process.removeListener("SIGINT", sigHandler);
    process.removeListener("SIGTERM", sigHandler);
  };

  const sigHandler = () => {
    shutdown();
    process.exit(0);
  };

  process.once("SIGINT", sigHandler);
  process.once("SIGTERM", sigHandler);

  return {
    server,
    db,
    ws,
    queue,
    warmer,
    gate,
    usage,
    models,
    rate,
    config,
    reloadConfig,
    shutdown,
  };
}
