// Upstream /v1/models client — fetches the model list and derives per-model
// concurrency weights from output pricing. Tiers:
//   output <  CHEAPEST_OUTPUT_THRESHOLD (0.9) → CHEAPEST_MODEL_WEIGHT (0.25)
//   output <  CHEAP_OUTPUT_THRESHOLD (2.0)   → CHEAP_MODEL_WEIGHT (0.5)
//   otherwise                                 → DEFAULT_MODEL_WEIGHT (1.0)

import { createLogger } from "./logger.js";
import type { ParsedModelInfo } from "./model-info-parser.js";
import { fetchModelsInfo } from "./models/fetch-info.js";
import type { VisionLookup, VisionTristate } from "./vision/detect.js";

const log = createLogger("models");

const DEFAULT_MODELS_PATH = "/v1/models";
const DEFAULT_MODELS_INFO_PATH = "/v1/models/info";
/** Pricing output threshold below which a model is considered "cheap". */
const CHEAP_OUTPUT_THRESHOLD = 2;
/** Weight assigned to cheap models (output pricing < threshold). */
const CHEAP_MODEL_WEIGHT = 0.5;
/** Pricing output threshold below which a model is considered "cheapest". */
const CHEAPEST_OUTPUT_THRESHOLD = 0.9;
/** Weight assigned to cheapest models (output pricing < threshold). */
const CHEAPEST_MODEL_WEIGHT = 0.25;
/** Default weight for models without cheap pricing. */
const DEFAULT_MODEL_WEIGHT = 1;

/**
 * Cold-start retry parameters. Hardcoded, not user-configurable.
 * Exported as a mutable object so tests can override for fast feedback;
 * production code reads the default values.
 */
export const COLD_START = {
  intervalMs: 30_000,
  maxRetries: 10,
};

/** Rich model info from /v1/models/info — faithfully typed from the upstream API. */

export interface ModelEntry {
  id: string;
  context_length: number;
  pricing: { input: number; output: number } | null;
  weight: number;
  info: ParsedModelInfo | null;
}

interface RawModel {
  id?: unknown;
  context_length?: unknown;
  pricing?: { input?: unknown; output?: unknown } | null;
}

interface RawModelsResponse {
  data?: RawModel[];
}

export interface ModelsClientOptions {
  target: string;
  refreshMs: number;
  /** Path appended to target for the model list. */
  path?: string;
  /** Path appended to target for the model info endpoint. */
  infoPath?: string;
}

/**
 * Fetches /v1/models on a timer, derives weights, and exposes synchronous
 * lookups. Failures are best-effort: last-known-good is served with ok=false.
 */
export class ModelsClient implements VisionLookup {
  private entries: Map<string, ModelEntry> = new Map();
  private parsedCatalog: Map<string, ParsedModelInfo> = new Map();
  private fetchedAt = 0;
  private ok = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetching: Promise<boolean> | null = null;
  private onChangeCb: (() => void) | null = null;
  private readonly target: string;
  private readonly refreshMs: number;
  private readonly path: string;
  private readonly infoPath: string;
  private started = false;
  private coldStartRetry = 0;

  constructor(opts: ModelsClientOptions) {
    this.target = opts.target.replace(/\/+$/, "");
    this.refreshMs = opts.refreshMs;
    this.path = opts.path ?? DEFAULT_MODELS_PATH;
    this.infoPath = opts.infoPath ?? DEFAULT_MODELS_INFO_PATH;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.kickoff();
  }

  private async kickoff(): Promise<void> {
    const success = await this.refresh().catch(() => false);
    if (!this.started) return;
    if (success || this.fetchedAt > 0) {
      this.beginSteadyState();
      return;
    }
    if (this.coldStartRetry >= COLD_START.maxRetries) {
      this.beginSteadyState();
      return;
    }
    this.timer = setInterval(() => {
      void this.coldStartTick().catch(() => {});
    }, COLD_START.intervalMs);
    this.timer.unref?.();
  }

  private async coldStartTick(): Promise<void> {
    if (!this.started) return;
    if (this.fetchedAt > 0) {
      this.transitionToSteadyState();
      return;
    }
    this.coldStartRetry++;
    const success = await this.refresh().catch(() => false);
    if (!this.started) return;
    if (success || this.fetchedAt > 0) {
      this.transitionToSteadyState();
      return;
    }
    if (this.coldStartRetry >= COLD_START.maxRetries) {
      this.transitionToSteadyState();
    }
  }

  private transitionToSteadyState(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.beginSteadyState();
  }

  private beginSteadyState(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, this.refreshMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.onChangeCb = null;
  }

  /** Subscribe to catalog updates (fired after each successful or failed refresh). */
  onChange(cb: () => void): void {
    this.onChangeCb = cb;
  }

  /** True if the catalog has been successfully fetched at least once. */
  isReady(): boolean {
    return this.fetchedAt > 0;
  }

  /** Timestamp (ms) of the last successful fetch, or 0 if never. */
  lastFetchedAt(): number {
    return this.fetchedAt;
  }

  /** Current fetch health. */
  healthy(): boolean {
    return this.ok;
  }

  /**
   * Look up the derived weight for a model id.
   * Returns DEFAULT_MODEL_WEIGHT if the model is unknown or the catalog
   * has not been fetched yet.
   */
  getWeight(modelId: string): number {
    const entry = this.entries.get(modelId);
    return entry?.weight ?? DEFAULT_MODEL_WEIGHT;
  }

  getVisionSupport(modelName: string): VisionTristate | null {
    const entry = this.entries.get(modelName);
    if (!entry?.info) return null;
    return entry.info.capabilities.supports_vision;
  }

  /** Snapshot of the parsed /v1/models/info catalog (empty if not fetched). */
  getParsedCatalog(): Map<string, ParsedModelInfo> {
    return this.parsedCatalog;
  }

  /** Get a model entry, or null if unknown. */
  get(modelId: string): ModelEntry | null {
    return this.entries.get(modelId) ?? null;
  }

  /** Snapshot of all known models (sorted by id). */
  list(): ModelEntry[] {
    return [...this.entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * Fetch the model list from the upstream API.
   * Deduplicates concurrent calls. Returns true on success, false on failure.
   */
  async refresh(): Promise<boolean> {
    if (this.fetching) return this.fetching;
    this.fetching = this.doFetch();
    try {
      return await this.fetching;
    } finally {
      this.fetching = null;
    }
  }

  private async doFetch(): Promise<boolean> {
    const url = `${this.target}${this.path}`;
    const infoUrl = `${this.target}${this.infoPath}`;
    const infoPromise = fetchModelsInfo(infoUrl).then(
      (m) => m,
      (e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.startsWith("HTTP ")) {
          log.warn(`info fetch failed: ${msg} from ${infoUrl}`);
        } else {
          log.warn(`info fetch parse failed: ${msg}`);
        }
        return null;
      },
    );
    try {
      const resp = await fetch(url, { method: "GET", signal: AbortSignal.timeout(15000) });
      if (!resp.ok) {
        this.ok = false;
        log.error(`fetch failed: HTTP ${resp.status} from ${url}`);
        this.onChangeCb?.();
        return false;
      }
      const parsed = (await resp.json()) as RawModelsResponse;
      const data = parsed.data;
      if (!Array.isArray(data)) {
        this.ok = false;
        log.error("fetch failed: response has no data[] array");
        this.onChangeCb?.();
        return false;
      }

      let infoMap: Map<string, ParsedModelInfo> | null = null;
      const infoResult = await infoPromise;
      if (infoResult) {
        infoMap = infoResult;
      }
      this.parsedCatalog = infoMap ?? new Map();

      const next = new Map<string, ModelEntry>();
      for (const raw of data) {
        const id = typeof raw.id === "string" ? raw.id : null;
        if (!id) continue;
        const pricing =
          raw.pricing && typeof raw.pricing === "object"
            ? {
                input: typeof raw.pricing.input === "number" ? raw.pricing.input : 0,
                output: typeof raw.pricing.output === "number" ? raw.pricing.output : 0,
              }
            : null;
        const weight =
          pricing && pricing.output < CHEAPEST_OUTPUT_THRESHOLD
            ? CHEAPEST_MODEL_WEIGHT
            : pricing && pricing.output < CHEAP_OUTPUT_THRESHOLD
              ? CHEAP_MODEL_WEIGHT
              : DEFAULT_MODEL_WEIGHT;
        next.set(id, {
          id,
          context_length: typeof raw.context_length === "number" ? raw.context_length : 0,
          pricing,
          weight,
          info: infoMap?.get(id) ?? null,
        });
      }

      this.entries = next;
      this.fetchedAt = Date.now();
      this.ok = true;
      const cheap = [...next.values()].filter((m) => m.weight < DEFAULT_MODEL_WEIGHT).length;
      const withInfo = [...next.values()].filter((m) => m.info !== null).length;
      log.info(
        `fetched ${next.size} models from ${url} — cheap (weight<1): ${cheap}, with info: ${withInfo}`,
      );
      this.onChangeCb?.();
      return true;
    } catch (err) {
      this.ok = false;
      log.error(`fetch error: ${err instanceof Error ? err.message : String(err)}`);
      this.onChangeCb?.();
      return false;
    }
  }
}
