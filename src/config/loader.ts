// Config loader: merges env vars > JSON config file > defaults into ProxyConfig.

import type { IncomingProtocol, ProxyConfig } from "../types.js";
import {
  OPENAI_CHAT_PATH,
  STAMP_REASONING_EFFORT_VALUE,
  UPSTREAM_TARGET,
  VISION_TARGET_PATH,
  WARMER_PATH,
} from "./constants.js";
import { DEFAULT_CONFIG } from "./defaults.js";
import {
  bool,
  envOrRawBool,
  envOrRawNum,
  loadJsonConfig,
  num,
  resolveUpstreamProtocol,
  str,
} from "./env.js";
import { ensureConfigFile } from "./file.js";

/**
 * Load configuration.
 * Precedence: env vars > JSON config file > defaults.
 * Writes the default config on first run if no file exists.
 * Removed-from-config fields (target, openai_path, warmer_path, vision_target,
 * rate_limit_window_seconds) are hardcoded — app is Umans-specific.
 * Misconfigured numeric fields fall back to their defaults.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): ProxyConfig {
  const configPath = ensureConfigFile();
  const raw = loadJsonConfig(configPath);

  const port = num(env.PORT ?? raw.port, 1945);
  const host = "127.0.0.1";
  const target = (env.TARGET ?? UPSTREAM_TARGET).replace(/\/+$/, "");
  const maxCaptures = num(env.MAX_CAPTURES ?? raw.max_captures, 200);
  const dbPath = str(env.DB_PATH ?? raw.db_path, "./umans-gate.db");
  const idleTimeout = Math.min(num(env.IDLE_TIMEOUT ?? raw.idle_timeout, 255), 255);
  const upstreamProtocol = resolveUpstreamProtocol(env.UPSTREAM_PROTOCOL ?? raw.upstream_protocol);
  const stampClaudeCode = bool(
    env.STAMP_CLAUDE_CODE_ENABLED ?? raw.stamp_claude_code_enabled,
    false,
  );
  const stampReasoningEffortEnabled = bool(
    env.STAMP_REASONING_EFFORT_ENABLED ?? raw.stamp_reasoning_effort_enabled,
    false,
  );
  const stampReasoningEffort = stampReasoningEffortEnabled ? STAMP_REASONING_EFFORT_VALUE : null;
  const openaiPath = OPENAI_CHAT_PATH;
  const warmerEnabled =
    env.WARMER_ENABLED !== undefined
      ? env.WARMER_ENABLED !== "false" && env.WARMER_ENABLED !== "0"
      : raw.warmer_enabled !== false;
  const warmerIntervalMs = num(env.WARMER_INTERVAL_MS ?? raw.warmer_interval_ms, 20000);
  const warmerPath = WARMER_PATH;

  const umansApiKey = env.UMANS_API_KEY ?? raw.umans_api_key ?? null;
  const dashboardToken = env.DASHBOARD_TOKEN ?? raw.dashboard_token ?? null;
  const usageRefreshMs = num(env.USAGE_REFRESH_MS ?? raw.usage_refresh_ms, 60000);
  const modelsRefreshMs = num(env.MODELS_REFRESH_MS ?? raw.models_refresh_ms, 3600000);
  const concurrencyHardCap = num(env.CONCURRENCY_HARD_CAP ?? raw.concurrency_hard_cap, 16);
  const concurrencySoftLimit = num(env.CONCURRENCY_SOFT_LIMIT ?? raw.concurrency_soft_limit, 8);
  const useHardCap = bool(env.USE_HARD_CAP ?? raw.use_hard_cap, false);
  const rateLimitRequests = num(env.RATE_LIMIT_REQUESTS ?? raw.rate_limit_requests, 0);
  const queueTimeoutMs = num(env.QUEUE_TIMEOUT_MS ?? raw.queue_timeout_ms, 30000);
  const maxQueueDepth = num(env.MAX_QUEUE_DEPTH ?? raw.max_queue_depth, 256);
  const releaseCooldownMs = num(env.RELEASE_COOLDOWN_MS ?? raw.release_cooldown_ms, 1000);
  const breakerThreshold = num(env.BREAKER_THRESHOLD ?? raw.breaker_threshold, 5);
  const breakerWindowMs = num(env.BREAKER_WINDOW_MS ?? raw.breaker_window_ms, 300000);
  const breakerCooldownMs = num(env.BREAKER_COOLDOWN_MS ?? raw.breaker_cooldown_ms, 60000);

  const visionStrategy = str(env.VISION_STRATEGY ?? raw.vision_strategy, "catalog") as
    | "never"
    | "catalog"
    | "always";
  const visionTarget =
    env.VISION_TARGET ?? `${UPSTREAM_TARGET.replace(/\/+$/, "")}${VISION_TARGET_PATH}`;
  const visionModel = env.VISION_MODEL ?? raw.vision_model ?? "umans-flash";
  const visionPrompt = str(
    env.VISION_PROMPT ?? raw.vision_prompt,
    DEFAULT_CONFIG.vision_prompt ?? "Describe this image concisely.",
  );
  const visionPromptVersion = num(env.VISION_PROMPT_VERSION ?? raw.vision_prompt_version, 2);
  const visionMaxImages = num(env.VISION_MAX_IMAGES ?? raw.vision_max_images, 5);
  const visionMaxDescriptionTokens = num(
    env.VISION_MAX_DESCRIPTION_TOKENS ?? raw.vision_max_description_tokens,
    4096,
  );
  const visionReasoningEffortRaw = env.VISION_REASONING_EFFORT ?? raw.vision_reasoning_effort;
  const visionReasoningEffort =
    visionReasoningEffortRaw === undefined || visionReasoningEffortRaw === null
      ? null
      : (visionReasoningEffortRaw as "none" | "low" | "medium" | "high");
  const visionTimeoutMs = num(env.VISION_TIMEOUT_MS ?? raw.vision_timeout_ms, 0);
  const visionCacheSize = num(env.VISION_CACHE_SIZE ?? raw.vision_cache_size, 1000);
  const visionCacheTtlMs = num(env.VISION_CACHE_TTL_MS ?? raw.vision_cache_ttl_ms, 604800000);
  const visionCacheMaxRows = num(env.VISION_CACHE_MAX_ROWS ?? raw.vision_cache_max_rows, 10000);
  const visionPersistentCache =
    env.VISION_PERSISTENT_CACHE !== undefined
      ? env.VISION_PERSISTENT_CACHE !== "false" && env.VISION_PERSISTENT_CACHE !== "0"
      : raw.vision_persistent_cache !== false;
  const visionConcurrency = num(env.VISION_CONCURRENCY ?? raw.vision_concurrency, 1);
  const visionMaxDimension = num(env.VISION_MAX_DIMENSION ?? raw.vision_max_dimension, 2048);
  const visionJpegQuality = num(env.VISION_JPEG_QUALITY ?? raw.vision_jpeg_quality, 92);
  const visionImageFormat = (env.VISION_IMAGE_FORMAT ?? raw.vision_image_format ?? "png") as
    | "jpeg"
    | "png";
  const visionImageDetail = (env.VISION_IMAGE_DETAIL ?? raw.vision_image_detail ?? "high") as
    | "auto"
    | "low"
    | "high";
  // Derived from vision_strategy: "catalog" uses cache-first (background) mode,
  // "always" forces intercept even for vision-capable models.
  const backgroundVision = visionStrategy === "catalog";
  const concurrencyMainReservation = num(
    env.CONCURRENCY_MAIN_RESERVATION ?? raw.concurrency_main_reservation,
    1,
  );
  const concurrencyVisionReservation =
    visionStrategy === "never"
      ? 0
      : Math.max(
          1,
          num(env.CONCURRENCY_VISION_RESERVATION ?? raw.concurrency_vision_reservation, 1),
        );

  const visionForceInterceptCapable = visionStrategy === "always";

  const captureBodyMaxBytes = envOrRawNum(
    env.CAPTURE_BODY_MAX_BYTES,
    raw,
    "capture_body_max_bytes",
    DEFAULT_CONFIG.capture_body_max_bytes ?? 1_000_000,
  );
  const queueMaxDepth = envOrRawNum(
    env.QUEUE_MAX_DEPTH,
    raw,
    "queue_max_depth",
    DEFAULT_CONFIG.queue_max_depth ?? 100,
  );
  const wsBackpressureLimit = envOrRawNum(
    env.WS_BACKPRESSURE_LIMIT,
    raw,
    "ws_backpressure_limit",
    DEFAULT_CONFIG.ws_backpressure_limit ?? 1_048_576,
  );
  const wsCloseOnBackpressureLimit = envOrRawBool(
    env.WS_CLOSE_ON_BACKPRESSURE_LIMIT,
    raw,
    "ws_close_on_backpressure_limit",
    DEFAULT_CONFIG.ws_close_on_backpressure_limit ?? true,
  );
  const visionPendingMaxBatch = envOrRawNum(
    env.VISION_PENDING_MAX_BATCH,
    raw,
    "vision_pending_max_batch",
    DEFAULT_CONFIG.vision_pending_max_batch ?? 50,
  );
  const compressionEnabled = envOrRawBool(
    env.COMPRESSION_ENABLED,
    raw,
    "compression_enabled",
    DEFAULT_CONFIG.compression_enabled ?? true,
  );
  const useWriteWorker = false;
  const upstreamTimeoutMs = envOrRawNum(
    env.UPSTREAM_TIMEOUT_MS,
    raw,
    "upstream_timeout_ms",
    DEFAULT_CONFIG.upstream_timeout_ms ?? 300000,
  );
  const experimentRewriteIds = envOrRawBool(
    env.EXPERIMENT_REWRITE_IDS,
    raw,
    "experiment_rewrite_ids",
    DEFAULT_CONFIG.experiment_rewrite_ids ?? false,
  );
  const experimentRewriteTtlMs = envOrRawNum(
    env.EXPERIMENT_REWRITE_TTL_MS,
    raw,
    "experiment_rewrite_ttl_ms",
    DEFAULT_CONFIG.experiment_rewrite_ttl_ms ?? 3600000,
  );
  const experimentStripOmoReminder = envOrRawBool(
    env.EXPERIMENT_STRIP_OMO_REMINDER,
    raw,
    "experiment_strip_omo_reminder",
    DEFAULT_CONFIG.experiment_strip_omo_reminder ?? false,
  );

  return {
    port,
    host,
    target,
    maxCaptures,
    dbPath,
    viewerPrefix: "/dashboard",
    flushIntervalMs: 50,
    flushBatch: 25,
    idleTimeout,
    upstreamProtocol,
    incomingProtocol: "http1.1" as IncomingProtocol,
    stampClaudeCode,
    stampReasoningEffort,
    openaiPath,
    warmerEnabled,
    warmerIntervalMs,
    warmerPath,
    umansApiKey,
    dashboardToken,
    usageRefreshMs,
    modelsRefreshMs,
    concurrencyHardCap,
    concurrencySoftLimit,
    useHardCap,
    rateLimitRequests,
    queueTimeoutMs,
    maxQueueDepth,
    releaseCooldownMs,
    breakerThreshold,
    breakerWindowMs,
    breakerCooldownMs,
    visionStrategy,
    visionTarget,
    visionModel,
    visionPrompt,
    visionPromptVersion,
    visionMaxImages,
    visionMaxDescriptionTokens,
    visionReasoningEffort,
    visionTimeoutMs,
    visionCacheSize,
    visionCacheTtlMs,
    visionCacheMaxRows,
    visionPersistentCache,
    visionConcurrency,
    visionMaxDimension,
    visionJpegQuality,
    visionImageFormat,
    visionImageDetail,
    backgroundVision,
    concurrencyMainReservation,
    concurrencyVisionReservation,
    visionForceInterceptCapable,
    captureBodyMaxBytes,
    queueMaxDepth,
    wsBackpressureLimit,
    wsCloseOnBackpressureLimit,
    visionPendingMaxBatch,
    compressionEnabled,
    useWriteWorker,
    upstreamTimeoutMs,
    experimentRewriteIds,
    experimentRewriteTtlMs,
    experimentStripOmoReminder,
  };
}
