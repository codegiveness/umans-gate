// Upstream /v1/models client — fetches the model list and derives per-model
// concurrency weights. Models with output pricing below the cheap-threshold
// (default 2.0) get a reduced weight (default 0.5); all others default to 1.0.

import { createLogger } from "./logger.js";
import type { ParsedModelInfo, VisionSupport } from "./model-info-parser.js";
import { fetchModelsInfo } from "./models/fetch-info.js";
import type { VisionLookup, VisionTristate } from "./vision/detect.js";

const log = createLogger("models");

const DEFAULT_MODELS_PATH = "/v1/models";
const DEFAULT_MODELS_INFO_PATH = "/v1/models/info";
/** Pricing output threshold below which a model is considered "cheap". */
const CHEAP_OUTPUT_THRESHOLD = 2;
/** Weight assigned to cheap models (output pricing < threshold). */
const CHEAP_MODEL_WEIGHT = 0.5;
/** Default weight for models without cheap pricing. */
const DEFAULT_MODEL_WEIGHT = 1;

/** Rich model info from /v1/models/info — faithfully typed from the upstream API. */
interface ModelInfo {
  name: string;
  display_name: string;
  description: string;
  base_model: {
    name: string;
    provider?: string;
    family?: string;
    oss_base?: string;
  };
  capabilities: {
    max_completion_tokens: number;
    recommended_max_tokens: number;
    context_window: number;
    supports_vision: VisionSupport;
    supports_tools: boolean;
    reasoning: {
      supported: boolean;
      can_disable: boolean;
      levels: string[];
      default_level: string | null;
    };
  };
  benchmarks: Record<string, unknown>;
  weights: {
    precision: string | undefined;
    hf_url: string | undefined;
  };
  stage?: string;
  lifecycle?: {
    playground_start_date?: string;
  };
}

export interface ModelEntry {
  id: string;
  context_length: number;
  pricing: { input: number; output: number } | null;
  weight: number;
  info: ModelInfo | null;
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
  private fetchedAt = 0;
  private ok = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private fetching: Promise<boolean> | null = null;
  private onChangeCb: (() => void) | null = null;
  private readonly target: string;
  private readonly refreshMs: number;
  private readonly path: string;
  private readonly infoPath: string;

  constructor(opts: ModelsClientOptions) {
    this.target = opts.target.replace(/\/+$/, "");
    this.refreshMs = opts.refreshMs;
    this.path = opts.path ?? DEFAULT_MODELS_PATH;
    this.infoPath = opts.infoPath ?? DEFAULT_MODELS_INFO_PATH;
  }

  start(): void {
    if (this.timer) return;
    void this.refresh().catch(() => {});
    this.timer = setInterval(() => {
      void this.refresh().catch(() => {});
    }, this.refreshMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
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
          pricing && pricing.output < CHEAP_OUTPUT_THRESHOLD
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
