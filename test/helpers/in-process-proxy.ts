// In-process proxy test harness.
//
// Wraps createProxyServer() on port 0 (OS-assigned) for integration tests.
// Drop-in compatible with the legacy startProxy() shape ({ port, baseUrl,
// kill() }) but also exposes db, ws, gate, models for direct state inspection.
//
// No OS subprocess. The proxy and the test share the same process; fetch()
// travels over real TCP to 127.0.0.1. Startup is instant (<5ms vs ~1.5s for
// subprocess spawn + health polling).
//
// INVARIANT: createProxyServer() must be synchronous — it captures process.env
// into a config object during the call. This harness sets XDG_CONFIG_HOME
// before the call and restores it immediately after. If the factory ever
// becomes async or reads env lazily, this harness will break.
//
// The factory registers `unhandledRejection` / `uncaughtException` handlers
// (log-only, no re-throw). shutdown() removes them, so calling kill() after
// each test keeps the handler count bounded to 1 per in-process instance.
// If kill() times out and force-stops the server, the handlers leak — but
// they are log-only and harmless.
//
// See ADR-0028 (docs/adr/0028-three-layer-test-pyramid.md) and CONTEXT.md
// → "In-process proxy" glossary entry.

import { randomUUID } from "node:crypto";
import { existsSync, rmSync, unlinkSync } from "node:fs";
import type {
  CaptureDB,
  ConcurrencyGate,
  ProxyServer,
  UmansUsageClient,
  WriteQueue,
  WsBroadcaster,
} from "../../src/index.js";
import type { ModelsClient } from "../../src/models.js";
import type { ProxyConfig } from "../../src/types.js";
import { assertDashboardAssetsFresh } from "./dashboard-assets.js";

export interface InProcessProxyHandle {
  /** OS-assigned port the proxy listens on. */
  port: number;
  /** Base URL for fetch() calls (http://127.0.0.1:<port>). */
  baseUrl: string;
  /** The underlying ProxyServer instance. */
  server: ProxyServer;
  /** Direct DB access for state assertions. */
  db: CaptureDB;
  /** Direct WS broadcaster for broadcast assertions. */
  ws: WsBroadcaster;
  /** Direct gate for concurrency state assertions. */
  gate: ConcurrencyGate;
  /** Direct models client for catalog state. */
  models: ModelsClient;
  /** Direct usage client for polling state. */
  usage: UmansUsageClient;
  /** Direct write queue for flush assertions. */
  queue: WriteQueue;
  /** The resolved config object. */
  config: ProxyConfig;
  /** Graceful shutdown + temp file cleanup. Idempotent. */
  kill(): Promise<void>;
}

export interface StartInProcessProxyOptions {
  /** Upstream target URL (the mock upstream). Required. */
  target: string;
  /** Vision target URL. Defaults to `${target}/v1/chat/completions`. */
  visionTarget?: string;
  /** Enable Claude Code stamp bundle. */
  stampClaudeCodeEnabled?: boolean;
  /** Enable GLM 5.2 Preserved Thinking stamp. */
  stampGlm52ThinkingEnabled?: boolean;
  /** Enable Kimi K2.7-Code Preserved Thinking stamp. */
  stampKimiK27CodeThinkingEnabled?: boolean;
  /** Enable reasoning_effort stamping on OpenAI route. */
  stampReasoningEffortEnabled?: boolean;
  /** Umans API key (enables usage polling, gate sizing). */
  umansApiKey?: string;
  /** Dashboard auth token. */
  dashboardToken?: string;
  /** Vision strategy. Defaults to "never" for test determinism. */
  visionStrategy?: "never" | "catalog" | "always";
  /** Concurrency soft limit. */
  concurrencySoftLimit?: number;
  /** Concurrency hard cap. */
  concurrencyHardCap?: number;
  /** Use hard cap as effective limit. */
  useHardCap?: boolean;
  /** Release cooldown in ms. Defaults to 0 for test speed. */
  releaseCooldownMs?: number;
  /** Usage refresh interval in ms. Defaults to 100 for fast polling. */
  usageRefreshMs?: number;
  /** Warmer enabled. Defaults to false for tests. */
  warmerEnabled?: boolean;
  /** Max captures (ring buffer size). */
  maxCaptures?: number;
  /** Enable compression. */
  compressionEnabled?: boolean;
  /** Additional config overrides (typed). */
  configOverrides?: Partial<Omit<ProxyConfig, "host">>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Start an in-process proxy server for integration tests.
 *
 * Creates a temp DB and temp config directory, calls createProxyServer()
 * with the provided options, and returns a handle with direct access to
 * internal state (db, ws, gate, models).
 *
 * Only XDG_CONFIG_HOME is set via env (required by ensureConfigFile()).
 * All other config is passed via options.config, which overrides the
 * env-derived config in the factory merge.
 *
 * Call `kill()` in afterAll/afterEach to shut down gracefully and clean up
 * temp files. `kill()` is idempotent and has a 2s timeout fallback.
 */
export async function startInProcessProxy(
  options: StartInProcessProxyOptions,
): Promise<InProcessProxyHandle> {
  assertDashboardAssetsFresh();

  const { createProxyServer } = await import("../../src/index.js");

  // Unique temp paths using crypto.randomUUID() for guaranteed uniqueness
  // even under parallel test execution within the same process.
  const testId = randomUUID();
  const dbPath = `/tmp/umans-gate-test-${testId}.db`;
  const configHome = `/tmp/umans-gate-test-config-${testId}`;

  // Only XDG_CONFIG_HOME needs env manipulation — ensureConfigFile() reads
  // it to determine where to write config.json. All other config is passed
  // via options.config which overrides envConfig in the factory merge.
  const prevXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configHome;

  let server: ProxyServer | undefined;
  try {
    server = createProxyServer({
      banner: false,
      config: {
        port: 0, // OS-assigned
        target: options.target,
        visionTarget: options.visionTarget ?? `${options.target}/v1/chat/completions`,
        dbPath,
        visionStrategy: options.visionStrategy ?? "never",
        stampClaudeCode: options.stampClaudeCodeEnabled ?? false,
        stampGlm52Thinking: options.stampGlm52ThinkingEnabled ?? false,
        stampKimiK27CodeThinking: options.stampKimiK27CodeThinkingEnabled ?? false,
        stampReasoningEffort: options.stampReasoningEffortEnabled ? "max" : null,
        umansApiKey: options.umansApiKey ?? null,
        dashboardToken: options.dashboardToken ?? null,
        warmerEnabled: options.warmerEnabled ?? false,
        releaseCooldownMs: options.releaseCooldownMs ?? 0,
        usageRefreshMs: options.usageRefreshMs ?? 100,
        concurrencySoftLimit: options.concurrencySoftLimit ?? 8,
        useHardCap: options.useHardCap ?? false,
        maxCaptures: options.maxCaptures ?? 200,
        compressionEnabled: options.compressionEnabled ?? true,
        ...options.configOverrides,
      },
    });
  } catch (err) {
    // Factory threw — the assignment never completed so `server` is undefined.
    // Nothing after Bun.serve() (banner, warmer, handler registration) can
    // throw in test config, so a leaked listening socket is not a realistic
    // risk. Clean up temp files from the failed attempt.
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        // ignore
      }
    }
    try {
      if (existsSync(configHome)) rmSync(configHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
    throw err;
  } finally {
    // Restore XDG_CONFIG_HOME immediately — createProxyServer() has
    // already captured env into its config object synchronously.
    process.env.XDG_CONFIG_HOME = prevXdg;
  }

  // Bun.serve() is synchronous — port is assigned immediately.
  const actualPort = server.server.port;
  if (typeof actualPort !== "number" || actualPort <= 0) {
    try {
      await server.shutdown();
    } catch {
      // ignore
    }
    throw new Error(`In-process proxy server has invalid port: ${actualPort}`);
  }
  const baseUrl = `http://127.0.0.1:${actualPort}`;

  // Bun.serve() binds synchronously, so the server is ready immediately.
  // This poll is defensive — first fetch should succeed on the first try.
  const healthHeaders: Record<string, string> = {};
  if (options.dashboardToken) {
    healthHeaders.Authorization = `Bearer ${options.dashboardToken}`;
  }
  let started = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/health`, { headers: healthHeaders });
      if (res.ok) {
        started = true;
        break;
      }
    } catch {
      await sleep(20);
    }
  }
  if (!started) {
    try {
      await server.shutdown();
    } catch {
      // ignore
    }
    throw new Error(`In-process proxy did not become healthy within 1s on port ${actualPort}`);
  }

  let killed = false;
  const kill = async (): Promise<void> => {
    if (killed) return;
    killed = true;

    // Shutdown with 2s timeout fallback — if graceful drain hangs (stuck
    // upstream, blocked DB flush), force-stop the Bun server.
    await Promise.race([
      server.shutdown().catch(() => {}),
      sleep(2000).then(() => {
        try {
          server.server.stop(true);
        } catch {
          // ignore — already stopped
        }
      }),
    ]);

    // Clean up temp files.
    for (const f of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        // ignore
      }
    }
    try {
      if (existsSync(configHome)) rmSync(configHome, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return {
    port: actualPort,
    baseUrl,
    server,
    db: server.db,
    ws: server.ws,
    gate: server.gate,
    models: server.models,
    usage: server.usage,
    queue: server.queue,
    config: server.config,
    kill,
  };
}
