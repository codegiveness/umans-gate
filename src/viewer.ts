// Viewer router — serves the inspector dashboard and REST API.
// All routes are under the /dashboard prefix.
//
// Asset resolution order:
// 1. dashboard/dist/ (production build from Vite)
// 2. 404

// Embedded assets: in compiled executables, Bun.embeddedFiles exposes imported
// `with { type: "file" }` assets as Blobs. In dev mode, it's an empty array.
// This allows the dashboard to work inside standalone compiled executables.
import { embeddedFiles } from "bun";
import pkg from "../package.json" with { type: "json" };
import { type AuthFailureLimiter, isTokenAuthorized } from "./auth.js";
import type { RawConfigInput } from "./config.js";
import {
  isRawConfigInput,
  type RawConfig,
  type ReloadResult,
  readConfigFile,
  resetConfig,
  saveConfigLocked,
  validateConfig,
} from "./config.js";
import type { CaptureDB } from "./db.js";
import {
  getAvailableMonths,
  getDailyUsage,
  getMonthSummary,
  getPricingTable,
} from "./economics.js";
import { EMBEDDED_ASSET_PATHS } from "./embedded-assets.js";
import type { TtftWatchdogState } from "./experiments/ttft-watchdog-state.js";
import { summary } from "./helpers.js";
import type { ConcurrencyGate } from "./limiter/index.js";
import type { ModelsClient } from "./models.js";
import type { ProxyConfig } from "./types.js";
import { getCachedVersionInfo, refreshVersionCheck } from "./updater.js";
import { selectMostUrgentBudget } from "./usage/budget.js";
import type { UmansUsageClient } from "./usage.js";
import type { UsageHistoryStore } from "./usage-history/index.js";
import { addDays, downsampleRange } from "./usage-history/index.js";
import type { VisionHandoff } from "./vision/handoff.js";
import type { WsBroadcaster } from "./ws.js";

interface NamedBlob extends Blob {
  name: string;
}

// Prevent tree-shaking of the embedded asset imports.
// EMBEDDED_ASSET_PATHS is referenced here so the bundler keeps the side-effect imports.
void EMBEDDED_ASSET_PATHS;

// Module-level: populated only in compiled executables.
// In dev mode, Bun.embeddedFiles is [] (empty array), so this stays null.
//
// Bun's `bun build --compile` flattens embedded file names to basenames and
// appends an 8-char content hash before the extension:
//   "index.html"                  → "index-v1ndr7bh.html"
//   "assets/index-CgigIO6a.js"    → "index-CgigIO6a-p25fh85q.js"
// We reverse this by stripping the hash and looking up the original relative
// path from EMBEDDED_ASSET_PATHS (which preserves the correct paths).
const EMBEDDED_ASSETS: Map<string, Blob> | null = (() => {
  try {
    if (!embeddedFiles || embeddedFiles.length === 0) return null;

    // Build basename → relative-path lookup from the known asset paths.
    // EMBEDDED_ASSET_PATHS has entries like "index.html", "assets/index-CgigIO6a.js".
    const pathByBasename = new Map<string, string>();
    for (const p of EMBEDDED_ASSET_PATHS) {
      const base = p.split("/").pop();
      if (base) pathByBasename.set(base, p);
    }

    // Bun appends an 8-char [a-z0-9] hash before the final extension.
    const BUN_HASH = /-([a-z0-9]{8})\.([^.]+)$/;

    const map = new Map<string, Blob>();
    for (const blob of embeddedFiles as NamedBlob[]) {
      const base = blob.name.split("/").pop();
      if (!base) continue;
      // Strip Bun's hash to recover the original basename.
      const dehashed = base.replace(BUN_HASH, ".$2");
      // Look up the original relative path (with Vite hash preserved).
      const relativePath = pathByBasename.get(dehashed) ?? dehashed;
      map.set(relativePath, blob);
      // Also store a Vite-hash-stripped version as a fallback lookup key.
      const viteDehashed = relativePath.replace(/-[A-Za-z0-9_-]{6,}(\.[^.]+)$/, "$1");
      if (viteDehashed !== relativePath) map.set(viteDehashed, blob);
    }
    return map.size > 0 ? map : null;
  } catch {
    return null;
  }
})();

export interface CreateViewerRouterOptions {
  db: CaptureDB;
  ws: WsBroadcaster;
  config: ProxyConfig;
  gate: ConcurrencyGate;
  usage: UmansUsageClient;
  usageHistory: UsageHistoryStore | null;
  vision: VisionHandoff | null;
  models: ModelsClient | null;
  authFailureLimiter?: AuthFailureLimiter;
  ttftState: TtftWatchdogState;
  reloadConfig?: () => ReloadResult;
  refreshLimits?: () => Promise<
    | {
        ok: true;
        hardCap: number;
        softLimit: number;
        requestsLimit: number | null;
        requestsHardCap: number | null;
        requestsWindowSeconds: number | null;
      }
    | { ok: false; error: string }
  >;
  restart?: () => void;
}

/** Content type map for common static file extensions. */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

/** Resolve content type from file path. */
function contentTypeFor(path: string): string {
  for (const [ext, ct] of Object.entries(CONTENT_TYPES)) {
    if (path.endsWith(ext)) return ct;
  }
  return "application/octet-stream";
}

/**
 * Try to resolve a static file from multiple candidate directories.
 * Returns the Bun file if found, null otherwise.
 *
 * Security: after resolving the relative path against each candidate base,
 * verify the resolved URL remains inside the base directory. This is an
 * explicit containment check that does not rely on URL-parser normalization
 * or Bun.file's own file-URL validation to prevent path traversal.
 */
async function resolveStaticFile(
  relativePath: string,
  candidates: URL[],
): Promise<Response | null> {
  if (EMBEDDED_ASSETS) {
    const blob = EMBEDDED_ASSETS.get(relativePath);
    if (blob) {
      return new Response(blob, {
        headers: { "content-type": contentTypeFor(relativePath) },
      });
    }
  }
  for (const base of candidates) {
    const fileUrl = new URL(relativePath, base);
    // Reject any resolved path that escapes the base directory.
    // base.href always ends with "/" (constructed with trailing slash),
    // so a contained fileUrl must start with base.href.
    if (!fileUrl.href.startsWith(base.href)) continue;
    try {
      const file = Bun.file(fileUrl);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "content-type": contentTypeFor(relativePath) },
        });
      }
    } catch {
      // Bun.file rejects malformed file URLs (e.g. encoded path
      // separators like %2f). Treat as "not found" and continue.
    }
  }
  return null;
}

/** Strip umans_api_key and dashboard_token from a RawConfig object, replacing with has_* booleans. */
function stripApiKey(written: RawConfig | null):
  | (Omit<RawConfig, "umans_api_key" | "dashboard_token"> & {
      has_api_key: boolean;
      has_dashboard_token: boolean;
    })
  | null {
  if (!written) return null;
  const { umans_api_key: _omitted, dashboard_token: _dashOmitted, ...safe } = written;
  return {
    ...safe,
    has_api_key: Boolean(_omitted),
    has_dashboard_token: Boolean(_dashOmitted),
  };
}

/** Result of matching a RegExp route pattern; `match[1]` is the capture id. */
type RegExpMatch = RegExpMatchArray;

/** All dependencies a route handler needs from the viewer router closure. */
interface ViewerRouteContext {
  url: URL;
  req: Request;
  pathname: string;
  /** Present only when the matched route's pattern is a RegExp. */
  match: RegExpMatch | null;
  db: CaptureDB;
  ws: WsBroadcaster;
  config: ProxyConfig;
  gate: ConcurrencyGate;
  usage: UmansUsageClient;
  usageHistory: UsageHistoryStore | null;
  vision: VisionHandoff | null;
  models: ModelsClient | null;
  ttftState: TtftWatchdogState;
  reloadConfig: (() => ReloadResult) | null;
  refreshLimits:
    | (() => Promise<
        | {
            ok: true;
            hardCap: number;
            softLimit: number;
            requestsLimit: number | null;
            requestsHardCap: number | null;
            requestsWindowSeconds: number | null;
          }
        | { ok: false; error: string }
      >)
    | null;
  restart: (() => void) | null;
}

/** A single route in the viewer dispatch table. */
interface ViewerRoute {
  method: string;
  pattern: string | RegExp;
  handler: (ctx: ViewerRouteContext) => Response | Promise<Response>;
}

/**
 * Create the viewer router that handles static asset serving and the REST API.
 * Returns null if the request is not a viewer route (caller should proxy it).
 */
export function createViewerRouter(options: CreateViewerRouterOptions) {
  const {
    db,
    ws,
    config,
    gate,
    usage,
    usageHistory,
    vision,
    models,
    authFailureLimiter,
    ttftState,
    reloadConfig,
    refreshLimits,
    restart,
  } = options;
  const VIEWER = config.viewerPrefix;
  const DETAIL_RE = new RegExp(`^${VIEWER}/api/captures/(\\d+)$`);

  // Candidate directories for static assets, in priority order.
  // When running from src/ (dev): dashboard/dist/ is in project root.
  // When running from dist/ (built): dashboard/dist/ is a sibling to dist/.
  const assetBases: URL[] = [
    // dashboard/dist/ relative to src/ (dev mode)
    new URL("../../dashboard/dist/", import.meta.url),
    // dashboard/dist/ relative to dist/ (built mode)
    new URL("../dashboard/dist/", import.meta.url),
  ];

  // Route table — exact priority order of the former if-chain.
  // API routes first, then the DETAIL_RE regex route, then static-file/SPA
  // fallback is handled after the loop (see handleViewer).
  const ROUTES: ViewerRoute[] = [
    {
      method: "GET",
      pattern: `${VIEWER}/api/captures`,
      handler: (ctx) => {
        const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 200), 1000);
        const rows = ctx.db.list(limit);
        return Response.json(rows.map(summary));
      },
    },
    {
      method: "POST",
      pattern: `${VIEWER}/api/clear`,
      handler: (ctx) => {
        ctx.db.clear();
        ctx.vision?.clearRecords();
        ctx.ws.broadcast({ type: "clear" });
        return Response.json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/gate`,
      handler: (ctx) => {
        const snap = ctx.usage.getSnapshot();
        const stats = ctx.gate.getStats(snap);
        const wd = ctx.ttftState.getStats();
        return Response.json({
          ...stats,
          watchdog_disabled: wd.disabled,
          watchdog_consecutive_failures: wd.consecutiveFailures,
          watchdog_failure_window_started_at: wd.windowStartedAt,
          priorityBudgetSummary: selectMostUrgentBudget(snap.priorityBudget),
        });
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/usage`,
      handler: (ctx) => Response.json(ctx.usage.getSnapshot()),
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/usage/samples`,
      handler: (ctx) => {
        const dateParam = ctx.url.searchParams.get("date") ?? "today";
        const date = dateParam === "today" ? new Date().toISOString().slice(0, 10) : dateParam;
        if (!ctx.usageHistory) return Response.json([]);
        return Response.json(ctx.usageHistory.getSamplesForDate(date));
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/usage/events`,
      handler: (ctx) => {
        const dateParam = ctx.url.searchParams.get("date") ?? "today";
        const date = dateParam === "today" ? new Date().toISOString().slice(0, 10) : dateParam;
        if (!ctx.usageHistory) return Response.json([]);
        return Response.json(ctx.usageHistory.getEventsForDate(date));
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/usage/daily`,
      handler: (ctx) => {
        if (!ctx.usageHistory) return Response.json([]);
        const today = new Date().toISOString().slice(0, 10);
        const fromParam = ctx.url.searchParams.get("from") ?? addDays(today, -29);
        const toParam = ctx.url.searchParams.get("to") ?? today;
        return Response.json(ctx.usageHistory.getDailyRange(fromParam, toParam));
      },
    },
    {
      method: "POST",
      pattern: `${VIEWER}/api/usage/downsample`,
      handler: (ctx) => {
        if (!ctx.usageHistory) return Response.json({ ok: true, rows: [] });
        const today = new Date().toISOString().slice(0, 10);
        const fromParam =
          ctx.url.searchParams.get("from") ??
          addDays(today, -Math.max(ctx.config.usageRawRetentionDays, 1));
        const toParam = ctx.url.searchParams.get("to") ?? today;
        const rows = downsampleRange(ctx.usageHistory, fromParam, toParam, {
          gapThresholdMinutes: ctx.config.usageGapThresholdMinutes,
          retentionDays: ctx.config.usageRawRetentionDays,
          force: true,
        });
        return Response.json({ ok: true, rows });
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/models`,
      handler: (ctx) => {
        if (!ctx.models) return Response.json({ models: [], fetched_at: 0, ok: false });
        return Response.json({
          models: ctx.models.list(),
          fetched_at: ctx.models.lastFetchedAt(),
          ok: ctx.models.healthy(),
        });
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/performance`,
      handler: (ctx) => Response.json(ctx.db.getPerformanceStats()),
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/vision-calls`,
      handler: (ctx) => {
        const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 100), 500);
        return Response.json(ctx.db.getVisionCallRecords(limit));
      },
    },
    {
      method: "DELETE",
      pattern: `${VIEWER}/api/vision-calls`,
      handler: (ctx) => {
        ctx.vision?.clearRecords();
        ctx.ws.broadcast({ type: "vision-clear" });
        return Response.json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/vision-cache-stats`,
      handler: (ctx) => Response.json(ctx.vision?.getCacheStats() ?? null),
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/config`,
      handler: (ctx) => {
        const raw = readConfigFile();
        const safe = stripApiKey(raw);
        if (!safe) return Response.json({ ok: false }, { status: 500 });
        return Response.json({
          ...safe,
          has_api_key: Boolean(ctx.config.umansApiKey),
          has_dashboard_token: Boolean(ctx.config.dashboardToken),
        });
      },
    },
    {
      method: "POST",
      pattern: `${VIEWER}/api/config`,
      handler: async (ctx) => {
        try {
          const raw = await ctx.req.json();
          if (!isRawConfigInput(raw)) {
            return Response.json(
              {
                ok: false,
                errors: ["Config must be a JSON object"],
                warnings: [],
                written: null,
              },
              { status: 400 },
            );
          }
          const body = raw as RawConfigInput;
          const snapshot = ctx.usage.getSnapshot();
          const result = await saveConfigLocked(body, {
            upstreamRequestsLimit: snapshot.requestsLimit,
          });
          const safe = stripApiKey(result.written);
          return Response.json({ ...result, written: safe }, { status: result.ok ? 200 : 400 });
        } catch (e) {
          console.error("[viewer] config save error:", e);
          return Response.json(
            {
              ok: false,
              errors: ["Invalid request body"],
              warnings: [],
              written: null,
            },
            { status: 400 },
          );
        }
      },
    },
    {
      method: "POST",
      pattern: `${VIEWER}/api/config/reset`,
      handler: async (ctx) => {
        const result = resetConfig();
        if (!result.ok) {
          return Response.json(result, { status: 500 });
        }
        const reload = ctx.reloadConfig?.();
        const safe = stripApiKey(result.written);
        if (ctx.refreshLimits) {
          const limits = await ctx.refreshLimits();
          return Response.json({
            ...result,
            written: safe,
            applied: reload?.applied ?? [],
            restartRequired: reload?.restartRequired ?? [],
            limits: limits.ok
              ? {
                  hardCap: limits.hardCap,
                  softLimit: limits.softLimit,
                  requestsLimit: limits.requestsLimit ?? null,
                  requestsHardCap: limits.requestsHardCap ?? null,
                  requestsWindowSeconds: limits.requestsWindowSeconds ?? null,
                }
              : null,
          });
        }
        return Response.json({
          ...result,
          written: safe,
          applied: reload?.applied ?? [],
          restartRequired: reload?.restartRequired ?? [],
        });
      },
    },
    {
      method: "POST",
      pattern: `${VIEWER}/api/config/validate`,
      handler: async (ctx) => {
        try {
          const body = (await ctx.req.json()) as RawConfigInput;
          const snapshot = ctx.usage.getSnapshot();
          const result = validateConfig(body, { upstreamRequestsLimit: snapshot.requestsLimit });
          return Response.json({ ok: result.ok, errors: result.errors, warnings: result.warnings });
        } catch (e) {
          console.error("[viewer] config validate error:", e);
          return Response.json(
            {
              ok: false,
              errors: ["Invalid request body"],
              warnings: [],
            },
            { status: 400 },
          );
        }
      },
    },
    {
      method: "POST",
      pattern: `${VIEWER}/api/config/reload`,
      handler: (ctx) => {
        if (!ctx.reloadConfig) {
          return Response.json(
            {
              ok: false,
              errors: ["Reload not available"],
              warnings: [],
              applied: [],
              restartRequired: [],
              configPath: "",
            },
            { status: 501 },
          );
        }
        const result = ctx.reloadConfig();
        return Response.json(result);
      },
    },
    {
      method: "POST",
      pattern: `${VIEWER}/api/usage/refresh-source`,
      handler: async (ctx) => {
        if (!ctx.refreshLimits) {
          return Response.json({ ok: false, error: "Refresh not available" }, { status: 501 });
        }
        const result = await ctx.refreshLimits();
        return Response.json(result);
      },
    },
    {
      method: "POST",
      pattern: `${VIEWER}/api/restart`,
      handler: (ctx) => {
        const restart = ctx.restart;
        if (!restart) {
          return Response.json({ ok: false, error: "Restart not available" }, { status: 501 });
        }
        setTimeout(() => restart(), 100);
        return Response.json({
          ok: true,
          message:
            "Server is restarting. Requires a process manager (bun --watch, systemd, pm2) to auto-restart — otherwise the server exits and stays down.",
        });
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/economics/summary`,
      handler: (ctx) => {
        const year = Number(ctx.url.searchParams.get("year") ?? new Date().getFullYear());
        const month = Number(ctx.url.searchParams.get("month") ?? new Date().getMonth() + 1);
        const summaryData = getMonthSummary(ctx.db.rawDb, year, month);
        const months = getAvailableMonths(ctx.db.rawDb);
        const pricing = getPricingTable(ctx.db.rawDb);
        return Response.json({ summary: summaryData, months, pricing });
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/economics/daily`,
      handler: (ctx) => {
        const limit = Math.min(Number(ctx.url.searchParams.get("limit") ?? 90), 365);
        const rows = getDailyUsage(ctx.db.rawDb, limit);
        return Response.json(rows);
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/economics/pricing`,
      handler: (ctx) => Response.json(getPricingTable(ctx.db.rawDb)),
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/version`,
      handler: () => Response.json(getCachedVersionInfo(pkg.version)),
    },
    {
      method: "POST",
      pattern: `${VIEWER}/api/version/check`,
      handler: async (ctx) => {
        await refreshVersionCheck(pkg.version, ctx.config.dashboardToken);
        return Response.json(getCachedVersionInfo(pkg.version));
      },
    },
    // DETAIL_RE regex route — must come after all exact-match API routes and
    // before static file fallback. Uses the capture id from match[1].
    {
      method: "GET",
      pattern: DETAIL_RE,
      handler: (ctx) => {
        const m = ctx.match;
        if (!m) return new Response("not found", { status: 404 });
        const row = ctx.db.get(Number(m[1]));
        if (!row) return new Response("not found", { status: 404 });
        return Response.json(row);
      },
    },
  ];

  /**
   * Handle a viewer request. Returns null for non-viewer paths (caller proxies).
   */
  async function handleViewer(url: URL, req: Request): Promise<Response | null> {
    const p = url.pathname;

    // WebSocket upgrade is handled by the server, not here.
    if (p === `${VIEWER}/ws`) return null;

    // Dashboard token auth: when configured, require Bearer token for API routes.
    if (config.dashboardToken && (p === `${VIEWER}/api` || p.startsWith(`${VIEWER}/api/`))) {
      if (authFailureLimiter?.isLockedOut()) {
        return new Response(JSON.stringify({ error: "too_many_attempts" }), {
          status: 429,
          headers: { "content-type": "application/json" },
        });
      }
      if (!isTokenAuthorized(req, config.dashboardToken)) {
        authFailureLimiter?.recordFailure();
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      }
      authFailureLimiter?.reset();
    }

    // Build context once for all routes.
    const ctx: ViewerRouteContext = {
      url,
      req,
      pathname: p,
      match: null,
      db,
      ws,
      config,
      gate,
      usage,
      usageHistory,
      vision,
      models,
      ttftState,
      reloadConfig: reloadConfig ?? null,
      refreshLimits: refreshLimits ?? null,
      restart: restart ?? null,
    };

    // Dispatch: first matching route (method + pattern) wins.
    for (const route of ROUTES) {
      if (route.method !== req.method) continue;

      if (route.pattern instanceof RegExp) {
        const m = p.match(route.pattern);
        if (m) {
          ctx.match = m;
          return route.handler(ctx);
        }
      } else if (p === route.pattern) {
        return route.handler(ctx);
      }
    }

    // Static assets: serve from dashboard/dist/
    // Map /dashboard/ → index.html, /dashboard/assets/* → assets/*
    if (p === VIEWER || p === `${VIEWER}/`) {
      const resp = await resolveStaticFile("index.html", assetBases);
      if (resp) {
        resp.headers.set("cache-control", "no-cache, no-store, must-revalidate");
        return resp;
      }
      return new Response("dashboard not built. Run: cd dashboard && bun run build", {
        status: 404,
      });
    }

    // Other static asset paths under /dashboard/
    if (p.startsWith(`${VIEWER}/`)) {
      const relativePath = p.slice(`${VIEWER}/`.length);

      // Try to serve from asset bases
      const resp = await resolveStaticFile(relativePath, assetBases);
      if (resp) return resp;

      // SPA fallback: if no asset matches, serve index.html (for client-side routing)
      // But only for non-API, non-asset paths
      if (!relativePath.startsWith("api/") && !relativePath.includes(".")) {
        const spaResp = await resolveStaticFile("index.html", assetBases);
        if (spaResp) {
          spaResp.headers.set("cache-control", "no-cache, no-store, must-revalidate");
          return spaResp;
        }
      }

      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  }

  return { handleViewer, VIEWER };
}
