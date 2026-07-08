// Viewer router — serves the inspector dashboard and REST API.
// All routes are under the /dashboard prefix.
//
// Asset resolution order:
// 1. dashboard/dist/ (production build from Vite)
// 2. public/ (legacy vanilla JS dashboard, for dev fallback)
// 3. 404

import { type ReloadResult, readConfigFile, saveConfig, validateConfig } from "./config.js";
import type { RawConfigInput } from "./config.js";
import type { CaptureDB } from "./db.js";
import { summary } from "./helpers.js";
import type { ConcurrencyGate } from "./limiter.js";
import type { ModelsClient } from "./models.js";
import type { ProxyConfig } from "./types.js";
import { summarizeByModel } from "./usage-extract.js";
import type { UmansUsageClient } from "./usage.js";
import type { VisionHandoff } from "./vision/handoff.js";
import type { WsBroadcaster } from "./ws.js";

export interface CreateViewerRouterOptions {
  db: CaptureDB;
  ws: WsBroadcaster;
  config: ProxyConfig;
  gate: ConcurrencyGate;
  usage: UmansUsageClient;
  vision: VisionHandoff | null;
  models: ModelsClient | null;
  reloadConfig?: () => ReloadResult;
  refreshLimits?: () => Promise<
    { ok: true; hardCap: number; softLimit: number } | { ok: false; error: string }
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
 */
async function resolveStaticFile(
  relativePath: string,
  candidates: URL[],
): Promise<Response | null> {
  for (const base of candidates) {
    const fileUrl = new URL(relativePath, base);
    const file = Bun.file(fileUrl);
    if (await file.exists()) {
      return new Response(file, {
        headers: { "content-type": contentTypeFor(relativePath) },
      });
    }
  }
  return null;
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
  vision: VisionHandoff | null;
  models: ModelsClient | null;
  reloadConfig: (() => ReloadResult) | null;
  refreshLimits:
    | (() => Promise<
        { ok: true; hardCap: number; softLimit: number } | { ok: false; error: string }
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
  const { db, ws, config, gate, usage, vision, models, reloadConfig, refreshLimits, restart } =
    options;
  const VIEWER = config.viewerPrefix;
  const DETAIL_RE = new RegExp(`^${VIEWER}/api/captures/(\\d+)$`);

  // Candidate directories for static assets, in priority order.
  // When running from src/ (dev): dashboard/dist/ and public/ are in project root.
  // When running from dist/ (built): dashboard/dist/ and public/ are siblings to dist/.
  const assetBases: URL[] = [
    // dashboard/dist/ relative to src/ (dev mode)
    new URL("../../dashboard/dist/", import.meta.url),
    // dashboard/dist/ relative to dist/ (built mode)
    new URL("../dashboard/dist/", import.meta.url),
    // public/ relative to src/ (dev mode)
    new URL("../../public/", import.meta.url),
    // public/ relative to dist/ (built mode)
    new URL("../public/", import.meta.url),
    // public/ relative to cwd (fallback)
    new URL("./public/", import.meta.url),
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
        ctx.ws.broadcast({ type: "clear" });
        return Response.json({ ok: true });
      },
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/gate`,
      handler: (ctx) => Response.json(ctx.gate.getStats(ctx.usage.getSnapshot())),
    },
    {
      method: "GET",
      pattern: `${VIEWER}/api/usage`,
      handler: (ctx) => Response.json(ctx.usage.getSnapshot()),
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
      pattern: `${VIEWER}/api/model-stats`,
      handler: (ctx) => {
        const latestN = ctx.config.usageStatsLatestN ?? 100;
        const rows = ctx.db.getModelStats(latestN);
        const stats = summarizeByModel(rows, latestN);
        return Response.json(stats);
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
      handler: () => {
        const raw = readConfigFile();
        return Response.json(raw);
      },
    },
    {
      method: "POST",
      pattern: `${VIEWER}/api/config`,
      handler: async (ctx) => {
        try {
          const body = (await ctx.req.json()) as RawConfigInput;
          const result = saveConfig(body);
          return Response.json(result, { status: result.ok ? 200 : 400 });
        } catch (e) {
          return Response.json(
            {
              ok: false,
              errors: [`Invalid JSON body: ${e instanceof Error ? e.message : String(e)}`],
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
      pattern: `${VIEWER}/api/config/validate`,
      handler: async (ctx) => {
        try {
          const body = (await ctx.req.json()) as RawConfigInput;
          const result = validateConfig(body);
          return Response.json({ ok: result.ok, errors: result.errors, warnings: result.warnings });
        } catch (e) {
          return Response.json(
            {
              ok: false,
              errors: [`Invalid JSON body: ${e instanceof Error ? e.message : String(e)}`],
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
        return Response.json({ ok: true, message: "Restarting — reconnect in a few seconds" });
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
      vision,
      models,
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

    // Static assets: serve from dashboard/dist/ or public/
    // Map /dashboard/ → index.html, /dashboard/assets/* → assets/*
    if (p === VIEWER || p === `${VIEWER}/`) {
      const resp = await resolveStaticFile("index.html", assetBases);
      if (resp) return resp;
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
        if (spaResp) return spaResp;
      }

      return new Response("not found", { status: 404 });
    }

    return new Response("not found", { status: 404 });
  }

  return { handleViewer, VIEWER };
}
