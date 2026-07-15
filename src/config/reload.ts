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
  "warmer_enabled",
  "warmer_interval_ms",
  "usage_refresh_ms",
  "umans_api_key",
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
