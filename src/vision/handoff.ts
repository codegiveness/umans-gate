// Vision handoff orchestrator.
// Drives the full pipeline: detect images → check cache → transcode → call
// vision model → wrap descriptions → replace image blocks in body.
//
// The orchestrator never holds the vision permit and the main proxy permit
// at the same time: the caller (proxy.ts) acquires the vision permit, invokes
// `processBody`, and only after it returns acquires the main upstream permit.
// All I/O here is async; the synchronous `DescriptionCache` is consulted
// before any network call so cache hits never touch the network.

import { flattenUsage } from "../db.js";
import type { CaptureDB } from "../db.js";
import { headersToObject, redactHeaders } from "../helpers.js";
import { ConcurrencyGate } from "../limiter/index.js";
import { createLogger } from "../logger.js";
import type { CaptureState, ProtocolConfig } from "../types.js";
import { extractOpenAiNonStreaming } from "../usage/extract.js";
import type { UsageMetrics } from "../usage/types.js";
import type { CompressionRecipe, DescriptionCache } from "./cache.js";
import { descriptionCacheKey } from "./cache.js";
import type { ApiKind, ImagePart, VisionLookup, VisionTristate } from "./detect.js";
import {
  cheapImageSignal,
  findAnthropicImageParts,
  findOpenAIImageParts,
  shouldRewrite,
} from "./detect.js";
import type { VisionHttpExchange, VisionRecordSink } from "./sink.js";
import { TranscodeError, transcodeImage } from "./transcode.js";
import { applyMaxImagesPolicy, failurePlaceholder, wrapDescription } from "./wrapper.js";

const log = createLogger("vision");

/** Strategy for when to rewrite image-bearing requests. */
type VisionStrategy = "never" | "catalog" | "always";

const DEFAULT_VISION_BREAKER_THRESHOLD = 100;
const DEFAULT_VISION_BREAKER_WINDOW_MS = 5000;
const DEFAULT_VISION_BREAKER_COOLDOWN_MS = 1000;
const DEFAULT_VISION_MAX_QUEUE_DEPTH = 256;
const DEFAULT_VISION_QUEUE_TIMEOUT_MS = 30000;

/**
 * Vision-handoff configuration extracted from {@link ProxyConfig} fields.
 * `target` / `model` / `apiKey` are nullable so the caller can disable
 * handoff by leaving them unset without constructing an invalid config.
 */
export interface VisionConfig {
  strategy: VisionStrategy;
  target: string | null;
  model: string | null;
  prompt: string;
  promptVersion: number;
  maxImages: number;
  maxDescriptionTokens: number;
  reasoningEffort: "none" | "low" | "medium" | "high" | null;
  timeoutMs: number;
  cacheSize: number;
  cacheTtlMs: number;
  cacheMaxRows: number;
  persistentCache: boolean;
  apiKey: string | null;
  forceInterceptCapable: boolean;
  concurrency: number;
  maxDimension: number;
  jpegQuality: number;
  imageFormat: "jpeg" | "png";
  imageDetail: "auto" | "low" | "high";
  /** Weight used when acquiring a vision permit from the shared concurrency gate. */
  visionWeight: number;
  /** Circuit-breaker failure threshold for the fallback concurrency gate. */
  breakerThreshold?: number;
  /** Window over which circuit-breaker failures are counted. */
  breakerWindowMs?: number;
  /** Cooldown before the circuit breaker allows traffic again. */
  breakerCooldownMs?: number;
  /** Maximum queued permits for the fallback concurrency gate. */
  maxQueueDepth?: number;
  /** Timeout for queued permits waiting for a free slot. */
  queueTimeoutMs?: number;
  /** When true, cache misses forward the original body immediately and process vision in the background. */
  backgroundVision: boolean;
}

/** Per-call statistics surfaced back to the caller. */
interface VisionStats {
  handoffCount: number;
  cacheHits: number;
  cacheMisses: number;
  visionCalls: number;
  latencyMs: number[];
}

/** A recorded vision call for debugging and dashboard visibility. */
export interface VisionCallRecord {
  id: number;
  timestamp: number;
  captureId: number | null;
  model: string;
  target: string;
  imageSize: number;
  imageHash: string | null;
  status:
    | "ok"
    | "cache_hit"
    | "http_error"
    | "timeout"
    | "fetch_error"
    | "parse_error"
    | "empty"
    | "skipped"
    | "aborted";
  httpStatus: number | null;
  latencyMs: number;
  description: string;
  error: string | null;
  incomingProtocol: string;
  upstreamProtocol: string;
  state: CaptureState;
}

/** Result of {@link processBody}. */
export interface ProcessBodyResult {
  body: unknown;
  changed: boolean;
  stats: VisionStats;
}

/** Per-image result from processImage — assembled by processBody into stats. */
interface ImageProcessResult {
  description: string;
  cacheHit: boolean;
  cacheMiss: boolean;
  visionCall: boolean;
  latencyMs: number;
}

/** Encoder version tag mixed into the cache key. Bump when transcode output bytes change. */
const ENCODER_VERSION = "bun-image-v2";

/**
 * Sentinel value returned (via throw) from {@link DescriptionCache.getOrCompute}
 * when a vision description is not found in either the LRU or persistent cache.
 *
 * Callers should treat this as a cache miss and proceed to invoke the upstream
 * vision model. The value is always empty (`""`) after the miss is caught.
 *
 * This is a unique `Symbol` rather than `undefined` or `null` so it can never
 * collide with a legitimate cached string (including empty descriptions) and
 * remains detectable across the `getOrCompute` callback boundary.
 */
const CACHE_MISS = Symbol("cache-miss");

function recipeFromConfig(cfg: VisionConfig): CompressionRecipe {
  return {
    format: cfg.imageFormat,
    quality: cfg.jpegQuality,
    max_dimension: cfg.maxDimension,
  };
}

/**
 * Orchestrates the vision handoff pipeline for a single request body.
 *
 * One instance is cheap to construct and holds no per-call state beyond the
 * constructor-supplied config and cache, so it can be reused across requests
 * or created per-request. The cache is shared by reference.
 */
export class VisionHandoff {
  private records: VisionCallRecord[] = [];
  private nextRecordId = 1;
  private readonly maxRecords: number;
  private readonly gate: ConcurrencyGate;
  private readonly inflight = new Map<string, Promise<string>>();

  constructor(
    private readonly config: VisionConfig,
    private readonly cache: DescriptionCache,
    private readonly catalog: VisionLookup | null = null,
    gate?: ConcurrencyGate,
    private readonly db?: CaptureDB,
    private readonly sink?: VisionRecordSink,
    private readonly protocolConfig: ProtocolConfig = {
      incomingProtocol: "http1.1",
      upstreamProtocol: "http1.1",
      upstreamTimeoutMs: 300000,
    },
  ) {
    this.maxRecords = Math.max(config.cacheSize, 200);
    this.gate =
      gate ??
      new ConcurrencyGate({
        hardCap: Math.max(1, config.concurrency),
        softLimit: Math.max(1, config.concurrency),
        releaseCooldownMs: 0,
        breakerThreshold: config.breakerThreshold ?? DEFAULT_VISION_BREAKER_THRESHOLD,
        breakerWindowMs: config.breakerWindowMs ?? DEFAULT_VISION_BREAKER_WINDOW_MS,
        breakerCooldownMs: config.breakerCooldownMs ?? DEFAULT_VISION_BREAKER_COOLDOWN_MS,
        maxQueueDepth: config.maxQueueDepth ?? DEFAULT_VISION_MAX_QUEUE_DEPTH,
        queueTimeoutMs: config.queueTimeoutMs ?? DEFAULT_VISION_QUEUE_TIMEOUT_MS,
        intentions: { vision: config.concurrency },
      });
  }

  get visionActive(): number {
    return this.gate.getIntentionActive("vision");
  }

  get visionQueued(): number {
    return this.gate.getIntentionQueued("vision");
  }

  getCacheStats(): {
    lru: { hits: number; misses: number; evictions: number; size: number };
    persistent: { hits: number; writes: number };
  } {
    return {
      lru: this.cache.stats,
      persistent: this.cache.persistentStats,
    };
  }

  /** Return recent vision call records (newest first). */
  getRecords(limit = 100): VisionCallRecord[] {
    return this.records.slice(-limit).reverse();
  }

  /** Clear all stored vision call records. */
  clearRecords(): void {
    this.records = [];
    this.nextRecordId = 1;
    this.db?.clearVisionCaptures();
  }

  private addRecord(
    rec: Omit<
      VisionCallRecord,
      "id" | "timestamp" | "incomingProtocol" | "upstreamProtocol" | "state"
    >,
    httpExchange?: VisionHttpExchange,
    usage: UsageMetrics | null = null,
    dbId?: number,
  ): void {
    const now = Date.now();
    const full: VisionCallRecord = {
      ...rec,
      id: this.nextRecordId++,
      timestamp: now,
      incomingProtocol: this.protocolConfig.incomingProtocol,
      upstreamProtocol: this.protocolConfig.upstreamProtocol,
      state: "done",
    };
    this.records.push(full);
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }

    this.sink?.record({ rec: full, httpExchange, usage, dbId });
  }

  /**
   * Process a request body: detect images, transcode + describe each via the
   * vision model (or serve from cache), and replace image blocks in the body
   * with text blocks containing the wrapped descriptions.
   *
   * The original `body` is never mutated — a deep clone is produced first.
   * Fail-open: on any per-image error (transcode, timeout, HTTP, parse), the
   * image is replaced with a deterministic failure placeholder rather than
   * aborting the whole request.
   *
   * If a model name and catalog are provided, the catalog strategy consults
   * the model's vision capability to decide whether to intercept.
   */
  async processBody(
    body: unknown,
    apiKind: ApiKind,
    modelName?: string,
    captureId?: number,
    signal?: AbortSignal,
  ): Promise<ProcessBodyResult> {
    const stats: VisionStats = {
      handoffCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      visionCalls: 0,
      latencyMs: [],
    };

    // 0. Catalog-aware gate: if we know the model and it supports vision,
    // decide whether to intercept based on strategy + forceInterceptCapable.
    if (this.config.strategy === "catalog" && modelName && this.catalog) {
      const supports: VisionTristate | null = this.catalog.getVisionSupport(modelName);
      if (
        !shouldRewrite(this.config.strategy, supports, apiKind, this.config.forceInterceptCapable)
      ) {
        return { body, changed: false, stats };
      }
    }

    // 1. Cheap signal: skip full parse when no image block can be present.
    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    if (!cheapImageSignal(bodyStr)) {
      return { body, changed: false, stats };
    }

    // 2. Extract image parts per API shape.
    const parts =
      apiKind === "anthropic" ? findAnthropicImageParts(body) : findOpenAIImageParts(body);
    if (parts.length === 0) {
      return { body, changed: false, stats };
    }

    // 3. Cap image count; overflow becomes deterministic placeholders.
    const { kept, overflow } = applyMaxImagesPolicy(parts, this.config.maxImages);
    stats.handoffCount = kept.length;

    // 4. Clone the body so the original is never mutated.
    const mutated = cloneBody(body);

    // 5. For each kept image: transcode → cache lookup → vision call → wrap.
    //    Processed in parallel; the concurrency gate serializes vision calls.
    const wrappedDescriptions: string[] = [];
    const results = await Promise.allSettled(
      kept.map((part) => this.processImage(part, captureId, signal)),
    );
    for (const result of results) {
      const r: ImageProcessResult =
        result.status === "fulfilled"
          ? result.value
          : {
              description: failurePlaceholder("generic", "unexpected error"),
              cacheHit: false,
              cacheMiss: false,
              visionCall: false,
              latencyMs: 0,
            };
      wrappedDescriptions.push(r.description);
      if (r.cacheHit) stats.cacheHits++;
      if (r.cacheMiss) stats.cacheMisses++;
      if (r.visionCall) {
        stats.visionCalls++;
        stats.latencyMs.push(r.latencyMs);
      }
    }

    // 6. Replace image blocks in the cloned body with text blocks.
    replaceImageBlocks(mutated, apiKind, wrappedDescriptions, overflow);

    return {
      body: mutated,
      changed: true,
      stats,
    };
  }

  /**
   * Cache-only version of {@link processBody}. Checks the LRU + persistent
   * cache for every image part. On any cache miss, the original body is
   * forwarded unchanged and a background `processBody` call is enqueued to
   * populate the cache for future requests.
   *
   * Returns `{ changed: true }` only when every image was a cache hit.
   */
  async processBodyCacheOnly(
    body: unknown,
    apiKind: ApiKind,
    modelName?: string,
    captureId?: number,
    signal?: AbortSignal,
  ): Promise<ProcessBodyResult> {
    const stats: VisionStats = {
      handoffCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
      visionCalls: 0,
      latencyMs: [],
    };

    if (this.config.strategy === "catalog" && modelName && this.catalog) {
      const supports: VisionTristate | null = this.catalog.getVisionSupport(modelName);
      if (
        !shouldRewrite(this.config.strategy, supports, apiKind, this.config.forceInterceptCapable)
      ) {
        return { body, changed: false, stats };
      }
    }

    const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
    if (!cheapImageSignal(bodyStr)) {
      return { body, changed: false, stats };
    }

    const parts =
      apiKind === "anthropic" ? findAnthropicImageParts(body) : findOpenAIImageParts(body);
    if (parts.length === 0) {
      return { body, changed: false, stats };
    }

    const { kept } = applyMaxImagesPolicy(parts, this.config.maxImages);
    stats.handoffCount = kept.length;

    const recipe = recipeFromConfig(this.config);

    // Parallel decode → transcode → cache lookup; rejection = cache miss.
    const results = await Promise.allSettled(
      kept.map((part) => {
        if (part.encoding === "url") {
          return Promise.reject(new Error("url-encoded image not cacheable"));
        }
        const decoded = decodeBase64(part.data);
        if (decoded === null) {
          return Promise.reject(new Error("invalid base64"));
        }
        return transcodeImage(decoded, {
          maxDimension: recipe.max_dimension,
          quality: recipe.quality,
          format: this.config.imageFormat,
        }).then((result) => {
          const cacheBytes = result.bytes;
          let cached = "";
          try {
            cached = this.cache.getOrCompute(
              cacheBytes,
              recipe,
              ENCODER_VERSION,
              this.config.model ?? "",
              this.config.promptVersion,
              () => {
                throw CACHE_MISS;
              },
            );
          } catch (err) {
            if (err !== CACHE_MISS) throw err;
          }
          return cached;
        });
      }),
    );

    const descriptions: string[] = [];
    let allHit = true;
    for (const result of results) {
      const cached = result.status === "fulfilled" ? result.value : "";
      if (cached !== "") {
        descriptions.push(wrapDescription(cached));
        stats.cacheHits++;
      } else {
        allHit = false;
        break;
      }
    }

    if (!allHit) {
      this.enqueueBackgroundVision(body, apiKind, modelName, captureId, signal);
      return { body, changed: false, stats };
    }

    const mutated = cloneBody(body);
    replaceImageBlocks(mutated, apiKind, descriptions, []);
    return { body: mutated, changed: true, stats };
  }

  private enqueueBackgroundVision(
    body: unknown,
    apiKind: ApiKind,
    modelName: string | undefined,
    captureId: number | undefined,
    signal: AbortSignal | undefined,
  ): void {
    const bgSignal = signal ? AbortSignal.any([signal]) : undefined;
    this.processBody(body, apiKind, modelName, captureId, bgSignal).catch((err) => {
      log.warn("background vision processing failed", {
        error: (err as Error).message,
        captureId,
      });
    });
  }

  /**
   * Process a single image part: decode → transcode → cache check → vision call → record.
   * Returns a result object that the caller assembles into stats + wrappedDescriptions.
   * Never rejects — errors produce a failure placeholder.
   */
  private async processImage(
    part: ImagePart,
    captureId: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<ImageProcessResult> {
    if (part.encoding === "url") {
      this.addRecord({
        captureId: captureId ?? null,
        model: this.config.model ?? "",
        target: this.config.target ?? "",
        imageSize: 0,
        imageHash: null,
        status: "skipped",
        httpStatus: null,
        latencyMs: 0,
        description: "",
        error: "url images unsupported in v1",
      });
      return {
        description: failurePlaceholder("generic", "url images unsupported in v1"),
        cacheHit: false,
        cacheMiss: false,
        visionCall: false,
        latencyMs: 0,
      };
    }

    const decoded = decodeBase64(part.data);
    if (decoded === null) {
      this.addRecord({
        captureId: captureId ?? null,
        model: this.config.model ?? "",
        target: this.config.target ?? "",
        imageSize: 0,
        imageHash: null,
        status: "parse_error",
        httpStatus: null,
        latencyMs: 0,
        description: "",
        error: "invalid base64 image data",
      });
      return {
        description: failurePlaceholder("parse", "invalid base64 image data"),
        cacheHit: false,
        cacheMiss: false,
        visionCall: false,
        latencyMs: 0,
      };
    }

    const recipe = recipeFromConfig(this.config);
    let cacheBytes: Uint8Array;
    try {
      const result = await transcodeImage(decoded, {
        maxDimension: recipe.max_dimension,
        quality: recipe.quality,
        format: this.config.imageFormat,
      });
      cacheBytes = result.bytes;
    } catch (err) {
      const errMsg = err instanceof TranscodeError ? `transcode ${err.code}` : "transcode failed";
      this.addRecord({
        captureId: captureId ?? null,
        model: this.config.model ?? "",
        target: this.config.target ?? "",
        imageSize: decoded.byteLength,
        imageHash: null,
        status: "fetch_error",
        httpStatus: null,
        latencyMs: 0,
        description: "",
        error: errMsg,
      });
      return {
        description: failurePlaceholder("generic", errMsg),
        cacheHit: false,
        cacheMiss: false,
        visionCall: false,
        latencyMs: 0,
      };
    }

    const imageHash = simpleHash(cacheBytes);

    let cached: string;
    try {
      cached = this.cache.getOrCompute(
        cacheBytes,
        recipe,
        ENCODER_VERSION,
        this.config.model ?? "",
        this.config.promptVersion,
        () => {
          throw CACHE_MISS;
        },
      );
    } catch (err) {
      if (err !== CACHE_MISS) throw err;
      cached = "";
    }
    if (cached !== "") {
      this.addRecord({
        captureId: captureId ?? null,
        model: this.config.model ?? "",
        target: this.config.target ?? "",
        imageSize: cacheBytes.byteLength,
        imageHash,
        status: "cache_hit",
        httpStatus: null,
        latencyMs: 0,
        description: cached,
        error: null,
      });
      return {
        description: wrapDescription(cached),
        cacheHit: true,
        cacheMiss: false,
        visionCall: false,
        latencyMs: 0,
      };
    }

    const cacheKey = descriptionCacheKey(
      cacheBytes,
      recipe,
      ENCODER_VERSION,
      this.config.model ?? "",
      this.config.promptVersion,
    );

    const existing = this.inflight.get(cacheKey);
    if (existing) {
      const desc = await existing;
      this.addRecord({
        captureId: captureId ?? null,
        model: this.config.model ?? "",
        target: this.config.target ?? "",
        imageSize: cacheBytes.byteLength,
        imageHash,
        status: "cache_hit",
        httpStatus: null,
        latencyMs: 0,
        description: desc,
        error: null,
      });
      return {
        description: wrapDescription(desc),
        cacheHit: true,
        cacheMiss: false,
        visionCall: false,
        latencyMs: 0,
      };
    }

    const startedAt = Date.now();
    const visionDbId = this.db?.insertVisionCapture({
      $method: "POST",
      $path: "/v1/chat/completions",
      $url: this.config.target ?? "",
      $rh: "{}",
      $rb: "{}",
      $rs: 0,
      $status: null,
      $rh2: "{}",
      $rb2: "",
      $rs2: 0,
      $ct: "application/json",
      $dur: 0,
      $state: "enqueued",
      $started_at: startedAt,
      $finished_at: 0,
      $inp: this.protocolConfig.incomingProtocol,
      $outp: this.protocolConfig.upstreamProtocol,
      $model: this.config.model ?? "",
      $parent_capture_id: captureId ?? null,
      $vision_meta: null,
      ...flattenUsage(null),
    });
    if (visionDbId) this.db?.setState(visionDbId, "streaming");

    const start = Date.now();
    const visionPromise = (async () => {
      const result = await this.callVisionRecorded(cacheBytes, signal);
      const stored = this.cache.getOrCompute(
        cacheBytes,
        recipe,
        ENCODER_VERSION,
        this.config.model ?? "",
        this.config.promptVersion,
        () => result.description,
      );
      return { result, stored };
    })();
    this.inflight.set(
      cacheKey,
      visionPromise.then((r) => r.stored),
    );

    let visionResult: Awaited<ReturnType<typeof this.callVisionRecorded>>;
    let stored: string;
    try {
      const r = await visionPromise;
      visionResult = r.result;
      stored = r.stored;
    } finally {
      this.inflight.delete(cacheKey);
    }
    const elapsed = Date.now() - start;

    if (visionDbId) {
      const finishedAt = Date.now();
      const metaJson = JSON.stringify({
        status: visionResult.status,
        httpStatus: visionResult.httpStatus,
        latencyMs: elapsed,
        description: visionResult.description,
        error: visionResult.error,
        imageHash,
        imageSize: cacheBytes.byteLength,
        model: this.config.model ?? "",
        target: this.config.target ?? "",
      });
      this.db?.updateVisionCapture({
        $id: visionDbId,
        $status:
          visionResult.status === "ok" || visionResult.status === "cache_hit"
            ? 200
            : (visionResult.httpStatus ?? null),
        $rh: visionResult.responseHeaders,
        $rb: visionResult.responseBody,
        $rs: Buffer.byteLength(visionResult.responseBody),
        $ct: "application/json",
        $sse: 0,
        $dur: elapsed,
        $fin: finishedAt,
        $status_source: "upstream",
        $gate_reason: null,
        $vision_meta: metaJson,
        $model: this.config.model ?? null,
        ...flattenUsage(visionResult.usage),
      });
    }

    this.addRecord(
      {
        captureId: captureId ?? null,
        model: this.config.model ?? "",
        target: this.config.target ?? "",
        imageSize: cacheBytes.byteLength,
        imageHash,
        status: visionResult.status,
        httpStatus: visionResult.httpStatus,
        latencyMs: elapsed,
        description: visionResult.description,
        error: visionResult.error,
      },
      {
        requestBody: visionResult.requestBody,
        requestHeaders: visionResult.requestHeaders,
        responseBody: visionResult.responseBody,
        responseHeaders: visionResult.responseHeaders,
      },
      visionResult.usage,
      visionDbId,
    );

    return {
      description: wrapDescription(stored),
      cacheHit: false,
      cacheMiss: true,
      visionCall: true,
      latencyMs: elapsed,
    };
  }

  /**
   * Call the vision model with a single JPEG image. Returns the description
   * text or a deterministic failure placeholder on any error (fail-open).
   *
   * Request shape follows the OpenAI chat-completions format so a single
   * vision endpoint can describe images regardless of the upstream API kind.
   */
  private async callVisionRecorded(
    imageBytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{
    description: string;
    status: VisionCallRecord["status"];
    httpStatus: number | null;
    error: string | null;
    requestBody: string;
    requestHeaders: string;
    responseBody: string;
    responseHeaders: string;
    usage: UsageMetrics | null;
  }> {
    const { target, model, prompt, reasoningEffort, imageFormat, imageDetail, apiKey } =
      this.config;
    if (!target || !model) {
      log.warn("callVision skipped: target or model not configured");
      return {
        description: failurePlaceholder("generic", "vision target or model not configured"),
        status: "skipped",
        httpStatus: null,
        error: "target or model not configured",
        requestBody: "",
        requestHeaders: "{}",
        responseBody: "",
        responseHeaders: "{}",
        usage: null,
      };
    }

    const authHeader = apiKey ? `Bearer ${apiKey}` : "";
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = authHeader;
    const requestHeaders = JSON.stringify(redactHeaders(headers));

    const base64 = encodeBase64(imageBytes);
    const mediaType = imageFormat === "png" ? "image/png" : "image/jpeg";

    const buildRequestBody = (): string => {
      const reqBody: Record<string, unknown> = {
        model,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              {
                type: "image_url",
                image_url: {
                  url: `data:${mediaType};base64,${base64}`,
                  detail: imageDetail,
                },
              },
            ],
          },
        ],
      };
      if (reasoningEffort !== null) {
        reqBody.reasoning_effort = reasoningEffort;
      }
      return JSON.stringify(reqBody);
    };

    const requestBody = buildRequestBody();
    const visionStart = Date.now();

    let permit: { release: () => void } | null = null;
    let response: Response;
    try {
      try {
        permit = await this.gate.acquire({
          intention: "vision",
          weight: this.config.visionWeight,
          signal,
        });
        response = await fetch(target, {
          method: "POST",
          headers,
          body: requestBody,
          signal,
        });
      } catch (err) {
        const elapsed = Date.now() - visionStart;
        if (err instanceof DOMException && err.name === "AbortError") {
          log.warn(`callVision ABORTED after ${elapsed}ms (client disconnect)`, {
            model,
            target,
            imgSize: imageBytes.byteLength,
          });
          return {
            description: failurePlaceholder("aborted", "client disconnected"),
            status: "aborted",
            httpStatus: null,
            error: "client disconnected",
            requestBody,
            requestHeaders,
            responseBody: "",
            responseHeaders: "{}",
            usage: null,
          };
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error(`callVision FETCH ERROR after ${elapsed}ms: ${errMsg}`, { model, target });
        return {
          description: failurePlaceholder("generic", "vision fetch failed"),
          status: "fetch_error",
          httpStatus: null,
          error: errMsg,
          requestBody,
          requestHeaders,
          responseBody: "",
          responseHeaders: "{}",
          usage: null,
        };
      }

      const elapsed = Date.now() - visionStart;
      const resHeadersJson = JSON.stringify(headersToObject(response.headers));
      const rawBody = await response.text().catch(() => "");
      if (!response.ok) {
        log.error(`callVision HTTP ${response.status} after ${elapsed}ms`, {
          model,
          target,
          imgSize: imageBytes.byteLength,
          body: rawBody.slice(0, 300),
        });
        return {
          description: failurePlaceholder("http_status", String(response.status)),
          status: "http_error",
          httpStatus: response.status,
          error: rawBody.slice(0, 500) || `HTTP ${response.status}`,
          requestBody,
          requestHeaders,
          responseBody: rawBody,
          responseHeaders: resHeadersJson,
          usage: null,
        };
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        log.error(`callVision PARSE ERROR after ${elapsed}ms — response not valid JSON`, { model });
        return {
          description: failurePlaceholder("parse", ""),
          status: "parse_error",
          httpStatus: response.status,
          error: "response not valid JSON",
          requestBody,
          requestHeaders,
          responseBody: rawBody,
          responseHeaders: resHeadersJson,
          usage: null,
        };
      }

      const text = extractOpenAIContent(parsed);
      if (!text) {
        log.error(
          `callVision EMPTY response after ${elapsed}ms — choices[0].message.content missing or empty`,
          { model },
        );
        return {
          description: failurePlaceholder("empty", ""),
          status: "empty",
          httpStatus: response.status,
          error: "choices[0].message.content missing or empty",
          requestBody,
          requestHeaders,
          responseBody: rawBody,
          responseHeaders: resHeadersJson,
          usage: null,
        };
      }
      log.info(`callVision OK in ${elapsed}ms`, {
        model,
        imgSize: imageBytes.byteLength,
        descLen: text.length,
      });
      const usage = extractOpenAiNonStreaming(parsed, elapsed);
      return {
        description: text,
        status: "ok",
        httpStatus: response.status,
        error: null,
        requestBody,
        requestHeaders,
        responseBody: rawBody,
        responseHeaders: resHeadersJson,
        usage,
      };
    } finally {
      permit?.release();
    }
  }
}

/**
 * Replace image blocks in `body` (already cloned) with text blocks carrying
 * the wrapped descriptions. OpenAI image_url parts and Anthropic image blocks
 * are both replaced in-place; overflow placeholders are appended after the
 * last replaced block of the relevant message so the model still sees them
 * in conversation order.
 */
function replaceImageBlocks(
  body: unknown,
  apiKind: ApiKind,
  descriptions: string[],
  overflow: string[],
): void {
  if (typeof body !== "object" || body === null) return;
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return;

  const cursor = { descIdx: 0, overflowIdx: 0 };
  const overflowText = overflow.length > 0 ? overflow.join("\n") : "";

  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const content = (msg as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    replaceInContentArray(content, apiKind, descriptions, overflow, cursor);

    if (
      overflowText &&
      cursor.descIdx >= descriptions.length &&
      cursor.overflowIdx < overflow.length
    ) {
      content.push({ type: "text", text: overflowText });
      cursor.overflowIdx = overflow.length;
    }
  }
}

function replaceInContentArray(
  content: unknown[],
  apiKind: ApiKind,
  descriptions: string[],
  overflow: string[],
  cursor: { descIdx: number; overflowIdx: number },
): void {
  for (let i = 0; i < content.length; i++) {
    const part = content[i];
    if (typeof part !== "object" || part === null) continue;
    const p = part as { type?: unknown; content?: unknown };

    if (apiKind === "openai" && p.type === "image_url") {
      if (cursor.descIdx < descriptions.length) {
        content[i] = { type: "text", text: descriptions[cursor.descIdx] };
        cursor.descIdx++;
      }
    } else if (apiKind === "anthropic" && p.type === "image") {
      if (cursor.descIdx < descriptions.length) {
        content[i] = {
          type: "text",
          text: descriptions[cursor.descIdx],
          cache_control: { type: "ephemeral" },
        };
        cursor.descIdx++;
      }
    } else if (apiKind === "anthropic" && p.type === "tool_result" && Array.isArray(p.content)) {
      replaceInContentArray(p.content, apiKind, descriptions, overflow, cursor);
    }
  }
}

/** Deep-clone a body via JSON round-trip. Falls back to the original on failure. */
function cloneBody(body: unknown): unknown {
  try {
    return JSON.parse(JSON.stringify(body));
  } catch {
    return body;
  }
}

/**
 * Decode a base64 string to bytes. Returns null on invalid input rather than
 * throwing — callers fail-open with a placeholder.
 */
function decodeBase64(data: string): Uint8Array | null {
  try {
    return new Uint8Array(Buffer.from(data, "base64"));
  } catch {
    return null;
  }
}

/** Encode bytes to a base64 string. */
function encodeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Fast non-cryptographic hash for dedup identification in vision call records. */
function simpleHash(bytes: Uint8Array): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Extract the assistant message text from an OpenAI chat-completions response.
 * Returns the empty string when the shape is unexpected.
 */
function extractOpenAIContent(parsed: unknown): string {
  if (typeof parsed !== "object" || parsed === null) return "";
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const first = choices[0];
  if (typeof first !== "object" || first === null) return "";
  const message = (first as { message?: { content?: unknown } }).message;
  if (!message) return "";
  const content = message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part !== "object" || part === null) continue;
      const t = (part as { type?: unknown; text?: unknown }).type;
      const txt = (part as { text?: unknown }).text;
      if (t === "text" && typeof txt === "string") return txt;
    }
  }
  // Never fall back to reasoning_content — it is the model's internal chain-of-thought,
  // not the actual image description. An empty return triggers a failure placeholder.
  return "";
}
