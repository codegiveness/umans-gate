// Hot-reload: apply config changes to a live ProxyConfig in-place.

import type { ProxyConfig } from "../types.js";
import type { RawConfig } from "./types.js";

/**
 * Fields that require a server restart to take effect (cannot be hot-reloaded).
 * Everything else can be applied to the live ProxyConfig in-place via reloadConfig().
 */
const RESTART_REQUIRED_FIELDS = new Set<keyof RawConfig>([
  "port",
  "max_captures",
  "db_path",
  "idle_timeout",
  "upstream_protocol",
  "queue_max_depth",
  "ws_backpressure_limit",
  "ws_close_on_backpressure_limit",
  "warmer_enabled",
  "warmer_interval_ms",
  "usage_refresh_ms",
  "umans_api_key",
  "dashboard_token",
  "models_refresh_ms",
  "vision_strategy",
  "vision_model",
  "vision_prompt",
  "vision_prompt_version",
  "vision_max_images",
  "vision_max_description_tokens",
  "vision_reasoning_effort",
  "vision_timeout_ms",
  "vision_cache_size",
  "vision_cache_ttl_ms",
  "vision_cache_max_rows",
  "vision_persistent_cache",
  "vision_max_dimension",
  "vision_jpeg_quality",
  "vision_image_format",
  "vision_image_detail",
  "vision_concurrency",
  "vision_pending_max_batch",
]);

/**
 * Table of hot-reloadable raw keys and the in-place assignment each performs
 * on the live ProxyConfig. Drives the data-driven apply loop below.
 */
const RELOAD_FIELDS: Array<{
  rawKey: keyof RawConfig;
  apply: (live: ProxyConfig, fresh: ProxyConfig) => void;
}> = [
  {
    rawKey: "stamp_claude_code_enabled",
    apply: (live, fresh) => {
      live.stampClaudeCode = fresh.stampClaudeCode;
    },
  },
  {
    rawKey: "stamp_glm_5_2_thinking_enabled",
    apply: (live, fresh) => {
      live.stampGlm52Thinking = fresh.stampGlm52Thinking;
    },
  },
  {
    rawKey: "stamp_kimi_k2_7_code_thinking_enabled",
    apply: (live, fresh) => {
      live.stampKimiK27CodeThinking = fresh.stampKimiK27CodeThinking;
    },
  },
  {
    rawKey: "usage_history_enabled",
    apply: (live, fresh) => {
      live.usageHistoryEnabled = fresh.usageHistoryEnabled;
    },
  },
  {
    rawKey: "usage_raw_retention_days",
    apply: (live, fresh) => {
      live.usageRawRetentionDays = fresh.usageRawRetentionDays;
    },
  },
  {
    rawKey: "usage_gap_threshold_minutes",
    apply: (live, fresh) => {
      live.usageGapThresholdMinutes = fresh.usageGapThresholdMinutes;
    },
  },
  {
    rawKey: "usage_idle_session_timeout_minutes",
    apply: (live, fresh) => {
      live.usageIdleSessionTimeoutMinutes = fresh.usageIdleSessionTimeoutMinutes;
    },
  },
  {
    rawKey: "stamp_reasoning_effort_enabled",
    apply: (live, fresh) => {
      live.stampReasoningEffort = fresh.stampReasoningEffort;
    },
  },
  {
    rawKey: "rate_limit_requests",
    apply: (live, fresh) => {
      live.rateLimitRequests = fresh.rateLimitRequests;
    },
  },
  {
    rawKey: "queue_timeout_ms",
    apply: (live, fresh) => {
      live.queueTimeoutMs = fresh.queueTimeoutMs;
    },
  },
  {
    rawKey: "max_queue_depth",
    apply: (live, fresh) => {
      live.maxQueueDepth = fresh.maxQueueDepth;
    },
  },
  {
    rawKey: "release_cooldown_ms",
    apply: (live, fresh) => {
      live.releaseCooldownMs = fresh.releaseCooldownMs;
    },
  },
  {
    rawKey: "breaker_threshold",
    apply: (live, fresh) => {
      live.breakerThreshold = fresh.breakerThreshold;
    },
  },
  {
    rawKey: "breaker_window_ms",
    apply: (live, fresh) => {
      live.breakerWindowMs = fresh.breakerWindowMs;
    },
  },
  {
    rawKey: "breaker_cooldown_ms",
    apply: (live, fresh) => {
      live.breakerCooldownMs = fresh.breakerCooldownMs;
    },
  },
  {
    rawKey: "concurrency_main_reservation",
    apply: (live, fresh) => {
      live.concurrencyMainReservation = fresh.concurrencyMainReservation;
    },
  },
  {
    rawKey: "concurrency_vision_reservation",
    apply: (live, fresh) => {
      live.concurrencyVisionReservation = fresh.concurrencyVisionReservation;
    },
  },
  {
    rawKey: "concurrency_hard_cap",
    apply: (live, fresh) => {
      live.concurrencyHardCap = fresh.concurrencyHardCap;
    },
  },
  {
    rawKey: "concurrency_soft_limit",
    apply: (live, fresh) => {
      live.concurrencySoftLimit = fresh.concurrencySoftLimit;
    },
  },
  {
    rawKey: "use_hard_cap",
    apply: (live, fresh) => {
      live.useHardCap = fresh.useHardCap;
    },
  },
  {
    rawKey: "compression_enabled",
    apply: (live, fresh) => {
      live.compressionEnabled = fresh.compressionEnabled;
    },
  },
  {
    rawKey: "capture_body_max_bytes",
    apply: (live, fresh) => {
      live.captureBodyMaxBytes = fresh.captureBodyMaxBytes;
    },
  },
  {
    rawKey: "upstream_timeout_ms",
    apply: (live, fresh) => {
      live.upstreamTimeoutMs = fresh.upstreamTimeoutMs;
    },
  },
  {
    rawKey: "experiment_rewrite_ids",
    apply: (live, fresh) => {
      live.experimentRewriteIds = fresh.experimentRewriteIds;
    },
  },
  {
    rawKey: "experiment_rewrite_ttl_ms",
    apply: (live, fresh) => {
      live.experimentRewriteTtlMs = fresh.experimentRewriteTtlMs;
    },
  },
  {
    rawKey: "experiment_strip_omo_reminder",
    apply: (live, fresh) => {
      live.experimentStripOmoReminder = fresh.experimentStripOmoReminder;
    },
  },
  {
    rawKey: "experiment_ttft_watchdog",
    apply: (live, fresh) => {
      live.experimentTtftWatchdog = fresh.experimentTtftWatchdog;
    },
  },
  {
    rawKey: "ttft_timeout_ms",
    apply: (live, fresh) => {
      live.ttftTimeoutMs = fresh.ttftTimeoutMs;
    },
  },
  {
    rawKey: "ttft_retry_max_attempts",
    apply: (live, fresh) => {
      live.ttftRetryMaxAttempts = fresh.ttftRetryMaxAttempts;
    },
  },
  {
    rawKey: "ttft_retry_gate_saturation_pct",
    apply: (live, fresh) => {
      live.ttftRetryGateSaturationPct = fresh.ttftRetryGateSaturationPct;
    },
  },
  {
    rawKey: "ttft_retry_cooldown_ms",
    apply: (live, fresh) => {
      live.ttftRetryCooldownMs = fresh.ttftRetryCooldownMs;
    },
  },
  {
    rawKey: "ttft_watchdog_multiplier",
    apply: (live, fresh) => {
      live.ttftWatchdogMultiplier = fresh.ttftWatchdogMultiplier;
    },
  },
  {
    rawKey: "ttft_watchdog_hard_cap_ms",
    apply: (live, fresh) => {
      live.ttftWatchdogHardCapMs = fresh.ttftWatchdogHardCapMs;
    },
  },
  {
    rawKey: "vision_intent_strategy",
    apply: (live, fresh) => {
      live.visionIntentStrategy = fresh.visionIntentStrategy;
    },
  },
  {
    rawKey: "vision_decomposition_enabled",
    apply: (live, fresh) => {
      live.visionDecompositionEnabled = fresh.visionDecompositionEnabled;
    },
  },
  {
    rawKey: "vision_decomposition_timeout_ms",
    apply: (live, fresh) => {
      live.visionDecompositionTimeoutMs = fresh.visionDecompositionTimeoutMs;
    },
  },
  {
    rawKey: "vision_crafting_timeout_ms",
    apply: (live, fresh) => {
      live.visionCraftingTimeoutMs = fresh.visionCraftingTimeoutMs;
    },
  },
  {
    rawKey: "vision_adjacent_text_max_chars",
    apply: (live, fresh) => {
      live.visionAdjacentTextMaxChars = fresh.visionAdjacentTextMaxChars;
    },
  },
  {
    rawKey: "vision_recent_messages_count",
    apply: (live, fresh) => {
      live.visionRecentMessagesCount = fresh.visionRecentMessagesCount;
    },
  },
  {
    rawKey: "vision_system_prompt_max_chars",
    apply: (live, fresh) => {
      live.visionSystemPromptMaxChars = fresh.visionSystemPromptMaxChars;
    },
  },
  {
    rawKey: "performance_sample_count",
    apply: (live, fresh) => {
      live.performanceSampleCount = fresh.performanceSampleCount;
    },
  },
  {
    rawKey: "incident_retention_days",
    apply: (live, fresh) => {
      live.incidentRetentionDays = fresh.incidentRetentionDays;
    },
  },
];

/**
 * Apply reloaded config to a live ProxyConfig in-place.
 * Only applies fields that can be hot-reloaded; flags restart-required changes.
 * Returns lists of applied fields and restart-required fields.
 */
export function applyReloadToConfig(
  live: ProxyConfig,
  fresh: ProxyConfig,
  oldRaw: RawConfig,
  newRaw: RawConfig,
): { applied: string[]; restartRequired: string[] } {
  const applied: string[] = [];
  const restartRequired: string[] = [];

  // Compare raw keys to detect changes.
  for (const key of Object.keys(newRaw) as (keyof RawConfig)[]) {
    const oldVal = oldRaw[key];
    const newVal = newRaw[key];
    const changed = JSON.stringify(oldVal) !== JSON.stringify(newVal);
    if (!changed) continue;

    if (RESTART_REQUIRED_FIELDS.has(key)) {
      restartRequired.push(key);
    } else {
      applied.push(key);
    }
  }

  // Apply hot-reloadable fields to the live ProxyConfig.
  // These are the fields that proxy.ts and stamp.ts read per-request.
  for (const { rawKey, apply } of RELOAD_FIELDS) {
    if (applied.includes(rawKey)) apply(live, fresh);
  }

  return { applied, restartRequired };
}
