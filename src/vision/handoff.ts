// Vision handoff orchestrator (ADR-0005).
//
// Drives the full pipeline: detect images → check cache → transcode → call
// vision model → wrap descriptions → replace image blocks in body.
//
// The orchestrator never holds the vision permit and the main proxy permit
// at the same time: the caller (proxy.ts) acquires the vision permit, invokes
// `processBody`, and only after it returns acquires the main upstream permit.
// All I/O here is async; the synchronous `DescriptionCache` is consulted
// before any network call so cache hits never touch the network.
//
// Per-image lifecycle (transcode + cache + vision call + inflight dedup + DB
// + sink) is delegated to {@link VisionImageProcessor}. This class keeps:
// catalog gate, cheap signal, image extraction, max-images policy, batch
// triage, decomposition orchestration, body cloning, context extraction,
// delegation to wrapper.ts for body rewriting, and the background-mode
// fire-and-forget path (`enqueueBackgroundVision` / `processBodyCacheOnly`).

import type { CaptureDB } from "../db.js";
import { ConcurrencyGate } from "../limiter/index.js";
import { createLogger } from "../logger.js";
import type { CaptureState, ProtocolConfig } from "../types.js";
import type { DescriptionCache } from "./cache.js";
import {
  type DecomposeConfig,
  type DecompositionResult,
  decomposeIfNeeded,
  decompositionCacheKey,
} from "./decompose.js";
import type { ApiKind, VisionLookup, VisionTristate } from "./detect.js";
import {
  cheapImageSignal,
  findAnthropicImageParts,
  findOpenAIImageParts,
  shouldRewrite,
} from "./detect.js";
import {
  CACHE_MISS,
  decodeBase64,
  ENCODER_VERSION,
  type ImageProcessResult,
  recipeFromConfig,
  resolveTriageStrategy,
  VisionImageProcessor,
} from "./image-processor.js";
import type { VisionRecordSink } from "./sink.js";
import { transcodeImage } from "./transcode.js";
import type { VisionStrategy as TriageStrategy } from "./triage.js";
import {
  applyMaxImagesPolicy,
  failurePlaceholder,
  replaceImageBlocks,
  wrapDescription,
} from "./wrapper.js";

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
  /** Intent-aware vision strategy (Task 9): "off" (generic only), "slotted", "crafted", or "auto" (triage decides). */
  intentStrategy?: "off" | "slotted" | "crafted" | "auto";
  /** Whether multi-image decomposition (DecoVQA+) is enabled. */
  decompositionEnabled?: boolean;
  /** Timeout for the decomposition LLM call (ms). */
  decompositionTimeoutMs?: number;
  /** Timeout for the crafting LLM call (Strategy D, ms). */
  craftingTimeoutMs?: number;
  /** Max chars to extract from adjacent text blocks (for VisionContext.adjacentText). */
  adjacentTextMaxChars?: number;
  /** Number of recent user messages to include in VisionContext.recentMessages. */
  recentMessagesCount?: number;
  /** Max chars to extract from the original system prompt. */
  systemPromptMaxChars?: number;
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
    | "aborted"
    | "gate_rejected";
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

/**
 * Per-image context threaded through processBody → processImage → callVisionRecorded.
 *
 * `adjacentText`, `isToolResult`, `positionInBatch`, `batchSize`, and
 * `originalSystemPrompt` come from the {@link ImagePart} (Task 1's extraction).
 * `recentMessages` is computed once per request from `body.messages[]` (user-only,
 * last N). `perImageQuestion` is reserved for Task 7's crafted strategy.
 */
export interface VisionContext {
  adjacentText?: string;
  isToolResult: boolean;
  positionInBatch: number;
  batchSize: number;
  recentMessages?: Array<{ role: string; text: string }>;
  perImageQuestion?: string;
  originalSystemPrompt?: string;
}

/**
 * Orchestrates the vision handoff pipeline for a single request body.
 *
 * One instance is cheap to construct and holds no per-call state beyond the
 * constructor-supplied config and cache, so it can be reused across requests
 * or created per-request. The cache is shared by reference.
 *
 * Per-image lifecycle (transcode + cache + vision call + inflight dedup + DB
 * + sink) is delegated to a {@link VisionImageProcessor} instance.
 */
export class VisionHandoff {
  private readonly gate: ConcurrencyGate;
  private readonly imageProcessor: VisionImageProcessor;
  /**
   * In-memory decomposition cache (Task 6, plan §7). Keyed by
   * `sha256(adjacentText + imageCount + (originalSystemPrompt ?? ''))`.
   * Session-scoped, no TTL — decomposing the same batch twice yields the
   * same sub-questions, so the LLM call runs at most once per batch key.
   */
  private readonly decompositionCache = new Map<string, string[]>();

  constructor(
    private readonly config: VisionConfig,
    private readonly cache: DescriptionCache,
    private readonly catalog: VisionLookup | null = null,
    gate?: ConcurrencyGate,
    db?: CaptureDB,
    sink?: VisionRecordSink,
    protocolConfig: ProtocolConfig = {
      incomingProtocol: "http1.1",
      upstreamProtocol: "http1.1",
      upstreamTimeoutMs: 300000,
    },
  ) {
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
    this.imageProcessor = new VisionImageProcessor(
      config,
      cache,
      this.gate,
      db,
      sink,
      protocolConfig,
      transcodeImage,
    );
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
    return this.imageProcessor.getRecords(limit);
  }

  /** Clear all stored vision call records. */
  clearRecords(): void {
    this.imageProcessor.clearRecords();
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
    //    Processed sequentially to bound peak memory from parallel Bun.Image
    //    decodes (V8). The concurrency gate serializes vision calls.
    const originalSystemPromptRaw = kept[0]?.originalSystemPrompt;
    const systemPromptMaxChars = this.config.systemPromptMaxChars ?? 1000;
    const originalSystemPrompt = originalSystemPromptRaw
      ? originalSystemPromptRaw.slice(0, systemPromptMaxChars)
      : undefined;
    const recentMessagesCount = this.config.recentMessagesCount ?? 6;
    const recentMessages = extractRecentUserMessages(body, recentMessagesCount);
    const wrappedDescriptions: string[] = [];
    const results: ImageProcessResult[] = [];

    // Task 6: batch-level triage. If ANY image routes to "decomposed",
    // call decomposeIfNeeded ONCE for the whole batch. The user question
    // (adjacentText) is the same for all sibling images in a batch, so
    // decomposing once for imageCount = kept.length is correct.
    // Uses kept[0].adjacentText as the batch-level question.
    const batchAdjacentText = kept[0]?.adjacentText ?? "";
    const batchSize = kept.length;
    const batchTriage = this.resolveTriageStrategy({
      adjacentText: batchAdjacentText,
      isToolResult: kept[0]?.isToolResult ?? false,
      imageCount: batchSize,
    });
    let decompositionResult: DecompositionResult = { decomposed: false };
    if (batchTriage === "decomposed" && (this.config.decompositionEnabled ?? true)) {
      // Check the in-memory cache first — same batch (question + count + intent)
      // reuses the previous sub-questions and skips the LLM call.
      const cacheKey = decompositionCacheKey(batchAdjacentText, batchSize, originalSystemPrompt);
      const cached = this.decompositionCache.get(cacheKey);
      if (cached) {
        decompositionResult = { decomposed: true, perImageQuestions: cached };
      } else {
        const decomposeConfig: DecomposeConfig = {
          target: this.config.target ?? "",
          model: this.config.model ?? "",
          visionWeight: this.config.visionWeight,
          apiKey: this.config.apiKey ?? undefined,
        };
        decompositionResult = await decomposeIfNeeded(
          fetch,
          decomposeConfig,
          this.gate,
          {
            userQuestion: batchAdjacentText,
            imageCount: batchSize,
            originalSystemPrompt,
          },
          signal,
          this.config.decompositionTimeoutMs ?? 3000,
        );
        if (decompositionResult.decomposed && decompositionResult.perImageQuestions) {
          this.decompositionCache.set(cacheKey, decompositionResult.perImageQuestions);
        }
      }
    }

    for (const part of kept) {
      const visionContext: VisionContext = {
        adjacentText: part.adjacentText,
        isToolResult: part.isToolResult,
        positionInBatch: part.positionInBatch,
        batchSize: part.batchSize,
        recentMessages,
        perImageQuestion: decompositionResult.decomposed
          ? decompositionResult.perImageQuestions?.[part.positionInBatch - 1]
          : undefined,
        originalSystemPrompt,
      };
      try {
        results.push(
          await this.imageProcessor.processImage(part, captureId, signal, visionContext),
        );
      } catch {
        results.push({
          description: failurePlaceholder("generic", "unexpected error"),
          cacheHit: false,
          cacheMiss: false,
          visionCall: false,
          latencyMs: 0,
        });
      }
    }

    for (const r of results) {
      wrappedDescriptions.push(r.description);
      if (r.cacheHit) stats.cacheHits++;
      if (r.cacheMiss) stats.cacheMisses++;
      if (r.visionCall) {
        stats.visionCalls++;
        stats.latencyMs.push(r.latencyMs);
      }
    }

    // 6. Replace image blocks in the cloned body with text blocks.
    const positions = kept.map((p) => ({
      positionInBatch: p.positionInBatch,
      batchSize: p.batchSize,
    }));
    replaceImageBlocks(mutated, apiKind, wrappedDescriptions, overflow, positions);

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

    // Synchronous cache-only fast path: decode the ORIGINAL bytes, compute the
    // cache key, and look up descriptions WITHOUT transcoding. Fail fast on any
    // miss so the cache-only path never pays the transcode cost for a hit.
    const descriptions: string[] = [];
    for (const part of kept) {
      if (part.encoding === "url") {
        this.enqueueBackgroundVision(body, apiKind, modelName, captureId, signal);
        return { body, changed: false, stats };
      }
      const decoded = decodeBase64(part.data);
      if (decoded === null) {
        this.enqueueBackgroundVision(body, apiKind, modelName, captureId, signal);
        return { body, changed: false, stats };
      }
      let cached = "";
      try {
        cached = this.cache.getOrCompute(
          decoded,
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
      if (cached === "") {
        this.enqueueBackgroundVision(body, apiKind, modelName, captureId, signal);
        // Prior hits had no effect — body is unchanged, so don't report them.
        stats.cacheHits = 0;
        return { body, changed: false, stats };
      }
      descriptions.push(wrapDescription(cached));
      stats.cacheHits++;
    }

    const mutated = cloneBody(body);
    const positions = kept.map((p) => ({
      positionInBatch: p.positionInBatch,
      batchSize: p.batchSize,
    }));
    replaceImageBlocks(mutated, apiKind, descriptions, [], positions);
    return { body: mutated, changed: true, stats };
  }

  private enqueueBackgroundVision(
    body: unknown,
    apiKind: ApiKind,
    modelName: string | undefined,
    captureId: number | undefined,
    _signal: AbortSignal | undefined,
  ): void {
    const bgSignal =
      this.config.timeoutMs > 0 ? AbortSignal.timeout(this.config.timeoutMs) : undefined;
    this.processBody(body, apiKind, modelName, captureId, bgSignal).catch((err) => {
      log.warn("background vision processing failed", {
        error: (err as Error).message,
        captureId,
      });
    });
  }

  /**
   * Resolve the vision strategy for a request, applying the configured
   * `intentStrategy` gate (Task 9). When `intentStrategy` is "off", always
   * returns "generic" (skip triage). When "slotted"/"crafted", forces that
   * strategy for non-tool-result images. When "auto" (default), delegates to
   * {@link triageVision} as-is.
   */
  private resolveTriageStrategy(input: {
    adjacentText?: string;
    isToolResult: boolean;
    imageCount: number;
  }): TriageStrategy {
    return resolveTriageStrategy(this.config, input);
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

/** Maximum character length of each recent message's text content. */
const VISION_RECENT_MESSAGE_MAX_CHARS = 1000;

/**
 * Extract the last N user messages from a request body's `messages[]` array.
 *
 * For each user message, the text content is extracted: if `content` is a
 * string, it is used directly; if it is an array of content blocks, the `text`
 * fields of `{type:"text", text}` blocks are concatenated. Each message's text
 * is capped at {@link VISION_RECENT_MESSAGE_MAX_CHARS} characters.
 *
 * Returns an array of `{role: "user", text: string}` in chronological order
 * (oldest first), with at most `count` entries.
 */
function extractRecentUserMessages(
  body: unknown,
  count: number,
): Array<{ role: string; text: string }> {
  if (typeof body !== "object" || body === null) return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  const userMsgs: Array<{ role: string; text: string }> = [];
  for (const msg of messages) {
    if (typeof msg !== "object" || msg === null) continue;
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== "user") continue;
    let text = "";
    if (typeof m.content === "string") {
      text = m.content;
    } else if (Array.isArray(m.content)) {
      text = concatRecentTextBlocks(m.content);
    }
    if (text.length > VISION_RECENT_MESSAGE_MAX_CHARS) {
      text = text.slice(0, VISION_RECENT_MESSAGE_MAX_CHARS);
    }
    userMsgs.push({ role: "user", text });
  }
  if (userMsgs.length <= count) return userMsgs;
  return userMsgs.slice(userMsgs.length - count);
}

/**
 * Concatenate the `text` fields of `{type:"text", text}` blocks in a content array.
 */
function concatRecentTextBlocks(arr: unknown[]): string {
  let out = "";
  for (const part of arr) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as { type?: unknown; text?: unknown };
    if (p.type === "text" && typeof p.text === "string") {
      out += p.text;
    }
  }
  return out;
}

export type { CompressionRecipe } from "./cache.js";
// Re-export shared constants/types so existing imports from handoff.ts keep
// working (e.g. tests that import ENCODER_VERSION or descriptionCacheKey).
export { descriptionCacheKey } from "./cache.js";
export { ENCODER_VERSION } from "./image-processor.js";
