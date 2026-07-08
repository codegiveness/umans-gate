// Model catalog client — fetches + caches /v1/models/info.
// Provides vision-capability lookup per model name so the vision handoff
// can make model-aware decisions (intercept only when needed).
//
// The catalog is fetched once on startup, then refreshed on a configurable
// interval. Lookups are synchronous from the caller's perspective — the
// in-memory map is consulted, and if the catalog hasn't been fetched yet
// (or the model is unknown), null is returned so the caller can fall back
// to the configured strategy.

import { createLogger } from "../logger.js";
import { fetchModelsInfo } from "../models/fetch-info.js";
import type { VisionLookup, VisionTristate } from "./detect.js";

const log = createLogger("catalog");

/** Subset of /v1/models/info entry that we care about. */
export interface ModelInfo {
  name: string;
  supports_vision: VisionTristate;
  context_window: number;
  max_completion_tokens: number;
  supports_tools: boolean;
  provider: string | null;
  family: string | null;
}

/** Catalog configuration extracted from ProxyConfig. */
export interface CatalogConfig {
  /** Full URL of the models/info endpoint. If null, catalog is disabled. */
  url: string | null;
  /** Bearer token for authentication. */
  apiKey: string | null;
  /** Refresh interval in milliseconds. */
  refreshMs: number;
}

/**
 * Fetches and caches the model catalog from /v1/models/info.
 *
 * One instance is shared across all requests. The catalog is fetched
 * asynchronously on startup — lookups before the first fetch returns null
 * so callers fall back to their configured default strategy.
 */
export class ModelInfoClient implements VisionLookup {
  private cache: Map<string, ModelInfo> = new Map();
  private fetchedAt = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetching: Promise<boolean> | null = null;

  constructor(private readonly config: CatalogConfig) {}

  /** Start the client: fetch catalog immediately, then on interval. */
  start(): void {
    if (!this.config.url) return;
    // Fire-and-forget initial fetch.
    this.refresh().catch(() => {});
    this.timer = setInterval(() => {
      this.refresh().catch(() => {});
    }, this.config.refreshMs);
  }

  /** Stop the refresh timer. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * Look up vision support for a model.
   * Returns null if the catalog hasn't been fetched or the model is unknown.
   */
  getVisionSupport(modelName: string): VisionTristate | null {
    if (this.cache.size === 0) return null;
    const info = this.cache.get(modelName);
    if (!info) return null;
    return info.supports_vision;
  }

  /** Get a full model info entry, or null if unknown. */
  get(modelName: string): ModelInfo | null {
    return this.cache.get(modelName) ?? null;
  }

  /** True if the catalog has been successfully fetched at least once. */
  isReady(): boolean {
    return this.fetchedAt > 0;
  }

  /** Timestamp (ms) of the last successful fetch, or 0 if never. */
  lastFetchedAt(): number {
    return this.fetchedAt;
  }

  /**
   * Fetch the catalog from the upstream API.
   * Deduplicates concurrent calls — if a fetch is already in flight, waits
   * for it instead of starting a second one.
   *
   * Returns true on success, false on failure.
   */
  async refresh(): Promise<boolean> {
    if (!this.config.url) return false;
    // Deduplicate: if already fetching, wait for the existing promise.
    if (this.fetching) return this.fetching;

    this.fetching = this.doFetch();
    try {
      return await this.fetching;
    } finally {
      this.fetching = null;
    }
  }

  private async doFetch(): Promise<boolean> {
    const { url, apiKey } = this.config;
    if (!url) return false;

    try {
      const next = projectCatalogInfo(await fetchModelsInfo(url, apiKey ?? undefined));

      this.cache = next;
      this.fetchedAt = Date.now();
      log.info(
        `fetched ${next.size} models from ${url} — vision-capable: ${[...next.values()].filter((m) => m.supports_vision === true).length}, via-handoff: ${[...next.values()].filter((m) => m.supports_vision === "via-handoff").length}, non-vision: ${[...next.values()].filter((m) => m.supports_vision === false).length}`,
      );
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.startsWith("HTTP ")) {
        log.error(`fetch failed: ${msg} from ${url}`);
      } else {
        log.error(`fetch error: ${msg}`);
      }
      return false;
    }
  }
}

function projectCatalogInfo(
  parsed: Map<string, import("../models/fetch-info.js").ParsedModelInfo>,
): Map<string, ModelInfo> {
  const out = new Map<string, ModelInfo>();
  for (const [key, v] of parsed) {
    out.set(key, {
      name: v.name,
      supports_vision: v.capabilities.supports_vision,
      context_window: v.capabilities.context_window,
      max_completion_tokens: v.capabilities.max_completion_tokens,
      supports_tools: v.capabilities.supports_tools,
      provider: v.base_model.provider ?? null,
      family: v.base_model.family ?? null,
    });
  }
  return out;
}
