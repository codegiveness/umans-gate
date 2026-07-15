// Config validation: coercion, field rules, warning rules, validateConfig.

import { DEFAULT_CONFIG } from "./defaults.js";
import type { RawConfig, RawConfigInput } from "./types.js";

/** Validation result. */
export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  normalized: RawConfig;
}

/** Reload result returned by the reload API. */
export interface ReloadResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  applied: string[];
  restartRequired: string[];
  configPath: string;
}

/**
 * Fields stored as integers on disk. The UI sends strings from <input> elements,
 * so coerce numeric strings to numbers before validation and before writing.
 * This is defense-in-depth: protects both the UI path and direct API callers.
 */
export const INT_FIELDS: (keyof RawConfig)[] = [
  "port",
  "max_captures",
  "idle_timeout",
  "warmer_interval_ms",
  "usage_refresh_ms",
  "models_refresh_ms",
  "concurrency_hard_cap",
  "concurrency_soft_limit",
  "rate_limit_requests",
  "queue_timeout_ms",
  "max_queue_depth",
  "release_cooldown_ms",
  "breaker_threshold",
  "breaker_window_ms",
  "breaker_cooldown_ms",
  "vision_prompt_version",
  "vision_max_images",
  "vision_max_description_tokens",
  "vision_timeout_ms",
  "vision_cache_size",
  "vision_cache_ttl_ms",
  "vision_cache_max_rows",
  "vision_max_dimension",
  "vision_jpeg_quality",
  "vision_concurrency",
  "concurrency_main_reservation",
  "concurrency_vision_reservation",
  "capture_body_max_bytes",
  "queue_max_depth",
  "ws_backpressure_limit",
  "vision_pending_max_batch",
  "upstream_timeout_ms",
];

/**
 * Coerce a raw config patch so that numeric strings become numbers and empty
 * strings for nullable fields become null. HTML form inputs always produce
 * strings; without this, Number.isInteger("7777") === false and validation
 * rejects every numeric field the UI sends.
 *
 * Returns a new object; does not mutate the input.
 */
export function coerceRawForValidation(raw: RawConfigInput): RawConfig {
  const out = { ...raw } as Record<string, unknown>;
  // Strip keys that are no longer in RawConfig (e.g. background_vision,
  // vision_force_intercept_capable, use_write_worker — now derived/hardcoded).
  // This prevents dead keys from persisting through save cycles.
  const knownKeys = new Set(Object.keys(DEFAULT_CONFIG));
  for (const k of Object.keys(out)) {
    if (!knownKeys.has(k)) {
      delete out[k];
    }
  }
  for (const k of INT_FIELDS) {
    const v = out[k];
    if (typeof v === "string" && v.length > 0) {
      const n = Number(v);
      if (!Number.isNaN(n)) {
        out[k] = n;
      }
    }
  }
  return out as unknown as RawConfig;
}

export interface FieldRule {
  name: string;
  errors: (n: RawConfig) => string[];
}

export interface WarningRule {
  name: string;
  warning: (n: RawConfig) => string | null;
}

export const FIELD_RULES: FieldRule[] = [
  {
    name: "port",
    errors: (n) =>
      n.port !== undefined && (!Number.isInteger(n.port) || n.port < 1 || n.port > 65535)
        ? ["port must be an integer between 1 and 65535"]
        : [],
  },
  {
    name: "max_captures",
    errors: (n) =>
      n.max_captures !== undefined && (!Number.isInteger(n.max_captures) || n.max_captures < 1)
        ? ["max_captures must be a positive integer"]
        : [],
  },
  {
    name: "db_path",
    errors: (n) => {
      if (n.db_path === undefined) return [];
      if (typeof n.db_path !== "string" || n.db_path.length === 0) {
        return ["db_path must be a non-empty string"];
      }
      if (n.db_path.includes("..")) {
        return ["db_path must not contain path traversal (..)"];
      }
      return [];
    },
  },
  {
    name: "idle_timeout",
    errors: (n) =>
      n.idle_timeout !== undefined &&
      (!Number.isInteger(n.idle_timeout) || n.idle_timeout < 1 || n.idle_timeout > 255)
        ? ["idle_timeout must be an integer between 1 and 255"]
        : [],
  },
  {
    name: "upstream_protocol",
    errors: (n) => {
      if (n.upstream_protocol === undefined) return [];
      const v = String(n.upstream_protocol).toLowerCase();
      return v !== "http1.1" && v !== "http2" && v !== "h2"
        ? ["upstream_protocol must be 'http1.1' or 'http2'"]
        : [];
    },
  },
  ...(
    ["stamp_claude_code_enabled", "stamp_reasoning_effort_enabled", "compression_enabled"] as const
  ).map((field) => ({
    name: field,
    errors: (n: RawConfig) =>
      n[field] !== undefined && typeof n[field] !== "boolean" ? [`${field} must be a boolean`] : [],
  })),
  {
    name: "warmer_enabled",
    errors: (n) =>
      n.warmer_enabled !== undefined && typeof n.warmer_enabled !== "boolean"
        ? ["warmer_enabled must be a boolean"]
        : [],
  },
  {
    name: "warmer_interval_ms",
    errors: (n) =>
      n.warmer_interval_ms !== undefined &&
      (!Number.isInteger(n.warmer_interval_ms) || n.warmer_interval_ms < 1000)
        ? ["warmer_interval_ms must be an integer >= 1000"]
        : [],
  },
  {
    name: "umans_api_key",
    errors: (n) =>
      n.umans_api_key !== undefined && typeof n.umans_api_key !== "string"
        ? ["umans_api_key must be a string"]
        : [],
  },
  {
    name: "usage_refresh_ms",
    errors: (n) =>
      n.usage_refresh_ms !== undefined &&
      (!Number.isInteger(n.usage_refresh_ms) || n.usage_refresh_ms < 1000)
        ? ["usage_refresh_ms must be an integer >= 1000"]
        : [],
  },
  {
    name: "models_refresh_ms",
    errors: (n) =>
      n.models_refresh_ms !== undefined &&
      (!Number.isInteger(n.models_refresh_ms) || n.models_refresh_ms < 1000)
        ? ["models_refresh_ms must be an integer >= 1000"]
        : [],
  },
  {
    name: "concurrency_hard_cap",
    errors: (n) =>
      n.concurrency_hard_cap !== undefined &&
      (!Number.isInteger(n.concurrency_hard_cap) || n.concurrency_hard_cap < 1)
        ? ["concurrency_hard_cap must be an integer >= 1"]
        : [],
  },
  {
    name: "concurrency_soft_limit",
    errors: (n) =>
      n.concurrency_soft_limit !== undefined &&
      (!Number.isInteger(n.concurrency_soft_limit) || n.concurrency_soft_limit < 1)
        ? ["concurrency_soft_limit must be an integer >= 1"]
        : [],
  },
  {
    // Cross-field: only checked when hard_cap is an integer >= 3.
    name: "concurrency_main_reservation",
    errors: (n) => {
      if (
        n.concurrency_hard_cap === undefined ||
        !Number.isInteger(n.concurrency_hard_cap) ||
        n.concurrency_main_reservation === undefined
      ) {
        return [];
      }
      const resMax = n.concurrency_hard_cap - 2;
      if (resMax < 1) return [];
      if (!Number.isInteger(n.concurrency_main_reservation) || n.concurrency_main_reservation < 1) {
        return ["concurrency_main_reservation must be a positive integer (min 1)"];
      }
      if (n.concurrency_main_reservation > resMax) {
        return [`concurrency_main_reservation must be <= hard_cap - 2 (=${resMax})`];
      }
      return [];
    },
  },
  {
    // Cross-field: only checked when hard_cap is an integer >= 3.
    // When vision_strategy is "never", the reservation is forced to 0 and
    // the field is allowed to be 0 (no slots wasted on disabled vision).
    name: "concurrency_vision_reservation",
    errors: (n) => {
      if (
        n.concurrency_hard_cap === undefined ||
        !Number.isInteger(n.concurrency_hard_cap) ||
        n.concurrency_vision_reservation === undefined
      ) {
        return [];
      }
      const resMax = n.concurrency_hard_cap - 2;
      if (resMax < 1) return [];
      if (!Number.isInteger(n.concurrency_vision_reservation)) {
        return ["concurrency_vision_reservation must be an integer"];
      }
      if (n.vision_strategy === "never") {
        // Normalized to 0 upstream; any value here is accepted as 0.
        return [];
      }
      if (n.concurrency_vision_reservation < 1) {
        return ["concurrency_vision_reservation must be a positive integer (min 1)"];
      }
      if (n.concurrency_vision_reservation > resMax) {
        return [`concurrency_vision_reservation must be <= hard_cap - 2 (=${resMax})`];
      }
      return [];
    },
  },
  {
    name: "rate_limit_requests",
    errors: (n) =>
      n.rate_limit_requests !== undefined &&
      n.rate_limit_requests !== null &&
      (!Number.isInteger(n.rate_limit_requests) || n.rate_limit_requests < -1)
        ? [
            "rate_limit_requests must be -1 (unlimited), 0 (auto-derive from /v1/usage), or a positive integer",
          ]
        : [],
  },
  {
    name: "queue_timeout_ms",
    errors: (n) =>
      n.queue_timeout_ms !== undefined &&
      (!Number.isInteger(n.queue_timeout_ms) || n.queue_timeout_ms < 100)
        ? ["queue_timeout_ms must be an integer >= 100"]
        : [],
  },
  {
    name: "max_queue_depth",
    errors: (n) =>
      n.max_queue_depth !== undefined &&
      (!Number.isInteger(n.max_queue_depth) || n.max_queue_depth < 1)
        ? ["max_queue_depth must be a positive integer"]
        : [],
  },
  {
    name: "release_cooldown_ms",
    errors: (n) =>
      n.release_cooldown_ms !== undefined &&
      (!Number.isInteger(n.release_cooldown_ms) || n.release_cooldown_ms < 0)
        ? ["release_cooldown_ms must be a non-negative integer"]
        : [],
  },
  {
    name: "breaker_threshold",
    errors: (n) =>
      n.breaker_threshold !== undefined &&
      (!Number.isInteger(n.breaker_threshold) || n.breaker_threshold < 1)
        ? ["breaker_threshold must be a positive integer"]
        : [],
  },
  {
    name: "breaker_window_ms",
    errors: (n) =>
      n.breaker_window_ms !== undefined &&
      (!Number.isInteger(n.breaker_window_ms) || n.breaker_window_ms < 1000)
        ? ["breaker_window_ms must be an integer >= 1000"]
        : [],
  },
  {
    name: "breaker_cooldown_ms",
    errors: (n) =>
      n.breaker_cooldown_ms !== undefined &&
      (!Number.isInteger(n.breaker_cooldown_ms) || n.breaker_cooldown_ms < 1000)
        ? ["breaker_cooldown_ms must be an integer >= 1000"]
        : [],
  },
  {
    name: "vision_strategy",
    errors: (n) =>
      n.vision_strategy !== undefined && !["never", "catalog", "always"].includes(n.vision_strategy)
        ? ["vision_strategy must be 'never', 'catalog', or 'always'"]
        : [],
  },
  {
    name: "vision_model",
    errors: (n) =>
      n.vision_model !== undefined && typeof n.vision_model !== "string"
        ? ["vision_model must be a string"]
        : [],
  },
  {
    name: "vision_prompt",
    errors: (n) =>
      n.vision_prompt !== undefined &&
      (typeof n.vision_prompt !== "string" || n.vision_prompt.length === 0)
        ? ["vision_prompt must be a non-empty string"]
        : [],
  },
  {
    name: "vision_prompt_version",
    errors: (n) =>
      n.vision_prompt_version !== undefined &&
      (!Number.isInteger(n.vision_prompt_version) || n.vision_prompt_version < 1)
        ? ["vision_prompt_version must be a positive integer"]
        : [],
  },
  {
    name: "vision_max_images",
    errors: (n) =>
      n.vision_max_images !== undefined &&
      (!Number.isInteger(n.vision_max_images) ||
        n.vision_max_images < 1 ||
        n.vision_max_images > 100)
        ? ["vision_max_images must be an integer between 1 and 100"]
        : [],
  },
  {
    name: "vision_max_description_tokens",
    errors: (n) =>
      n.vision_max_description_tokens !== undefined &&
      (!Number.isInteger(n.vision_max_description_tokens) ||
        n.vision_max_description_tokens < 1 ||
        n.vision_max_description_tokens > 200000)
        ? ["vision_max_description_tokens must be an integer between 1 and 200000"]
        : [],
  },
  {
    name: "vision_timeout_ms",
    errors: (n) =>
      n.vision_timeout_ms !== undefined &&
      (!Number.isInteger(n.vision_timeout_ms) || n.vision_timeout_ms < 0)
        ? ["vision_timeout_ms must be a non-negative integer (0 = no timeout)"]
        : [],
  },
  {
    name: "vision_cache_size",
    errors: (n) =>
      n.vision_cache_size !== undefined &&
      (!Number.isInteger(n.vision_cache_size) || n.vision_cache_size < 100)
        ? ["vision_cache_size must be an integer >= 100"]
        : [],
  },
  {
    name: "vision_concurrency",
    errors: (n) =>
      n.vision_concurrency !== undefined &&
      (!Number.isInteger(n.vision_concurrency) ||
        n.vision_concurrency < 1 ||
        n.vision_concurrency > 20)
        ? ["vision_concurrency must be an integer between 1 and 20"]
        : [],
  },
  {
    name: "vision_reasoning_effort",
    errors: (n) =>
      n.vision_reasoning_effort !== undefined &&
      n.vision_reasoning_effort !== null &&
      !["none", "low", "medium", "high"].includes(n.vision_reasoning_effort)
        ? ["vision_reasoning_effort must be 'none', 'low', 'medium', 'high', or null"]
        : [],
  },
  {
    name: "vision_max_dimension",
    errors: (n) =>
      n.vision_max_dimension !== undefined &&
      (!Number.isInteger(n.vision_max_dimension) ||
        n.vision_max_dimension < 256 ||
        n.vision_max_dimension > 8192)
        ? ["vision_max_dimension must be an integer between 256 and 8192"]
        : [],
  },
  {
    name: "vision_jpeg_quality",
    errors: (n) =>
      n.vision_jpeg_quality !== undefined &&
      (!Number.isInteger(n.vision_jpeg_quality) ||
        n.vision_jpeg_quality < 1 ||
        n.vision_jpeg_quality > 100)
        ? ["vision_jpeg_quality must be an integer between 1 and 100"]
        : [],
  },
  {
    name: "vision_image_format",
    errors: (n) =>
      n.vision_image_format !== undefined && !["jpeg", "png"].includes(n.vision_image_format)
        ? ["vision_image_format must be 'jpeg' or 'png'"]
        : [],
  },
  {
    name: "vision_image_detail",
    errors: (n) =>
      n.vision_image_detail !== undefined &&
      !["auto", "low", "high"].includes(n.vision_image_detail)
        ? ["vision_image_detail must be 'auto', 'low', or 'high'"]
        : [],
  },
  {
    name: "vision_cache_ttl_ms",
    errors: (n) =>
      n.vision_cache_ttl_ms !== undefined &&
      (!Number.isInteger(n.vision_cache_ttl_ms) || n.vision_cache_ttl_ms < 1000)
        ? ["vision_cache_ttl_ms must be an integer >= 1000"]
        : [],
  },
  {
    name: "vision_cache_max_rows",
    errors: (n) =>
      n.vision_cache_max_rows !== undefined &&
      (!Number.isInteger(n.vision_cache_max_rows) || n.vision_cache_max_rows < 100)
        ? ["vision_cache_max_rows must be an integer >= 100"]
        : [],
  },
  {
    name: "vision_persistent_cache",
    errors: (n) =>
      n.vision_persistent_cache !== undefined && typeof n.vision_persistent_cache !== "boolean"
        ? ["vision_persistent_cache must be a boolean"]
        : [],
  },
  {
    name: "capture_body_max_bytes",
    errors: (n) =>
      n.capture_body_max_bytes !== undefined &&
      (!Number.isInteger(n.capture_body_max_bytes) || n.capture_body_max_bytes < 0)
        ? ["capture_body_max_bytes must be a non-negative integer (0 = unlimited)"]
        : [],
  },
  {
    name: "queue_max_depth",
    errors: (n) =>
      n.queue_max_depth !== undefined &&
      (!Number.isInteger(n.queue_max_depth) || n.queue_max_depth < 1)
        ? ["queue_max_depth must be a positive integer"]
        : [],
  },
  {
    name: "ws_backpressure_limit",
    errors: (n) =>
      n.ws_backpressure_limit !== undefined &&
      (!Number.isInteger(n.ws_backpressure_limit) || n.ws_backpressure_limit < 0)
        ? ["ws_backpressure_limit must be a non-negative integer (0 = Bun default)"]
        : [],
  },
  {
    name: "ws_close_on_backpressure_limit",
    errors: (n) =>
      n.ws_close_on_backpressure_limit !== undefined &&
      typeof n.ws_close_on_backpressure_limit !== "boolean"
        ? ["ws_close_on_backpressure_limit must be a boolean"]
        : [],
  },
  {
    name: "vision_pending_max_batch",
    errors: (n) =>
      n.vision_pending_max_batch !== undefined &&
      (!Number.isInteger(n.vision_pending_max_batch) || n.vision_pending_max_batch < 1)
        ? ["vision_pending_max_batch must be a positive integer"]
        : [],
  },
];

export const WARNING_RULES: WarningRule[] = [
  {
    name: "warmer_disabled",
    warning: (n) =>
      n.warmer_enabled === false
        ? "Connection warmer is disabled — first request after idle will have ~750ms cold-start penalty"
        : null,
  },
  {
    name: "rate_limit_disabled",
    warning: (n) =>
      n.rate_limit_requests === -1
        ? "Rate limiting is unlimited (rate_limit_requests=-1). No request cap is enforced."
        : null,
  },
  {
    name: "stamp_claude_code_off",
    warning: (n) =>
      n.stamp_claude_code_enabled !== true
        ? "Claude Code stamping is off — ephemeral cache entries will have no default TTL, no top_k/max_tokens/thinking/output_config/context_management injection"
        : null,
  },
  {
    name: "umans_api_key_empty",
    warning: (n) =>
      n.umans_api_key === "" || n.umans_api_key === undefined
        ? "umans_api_key is empty — proxy runs in fail-safe mode (worst-case limits, priority_low=true). Set umans_api_key in the Server section to enable usage-based limits."
        : null,
  },
];

/**
 * Validate a raw config object. Returns errors (blocking), warnings (non-blocking),
 * and a normalized copy with defaults filled in.
 */
export function validateConfig(raw: RawConfigInput): ValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const coerced = coerceRawForValidation(raw);
  const n: RawConfig = { ...DEFAULT_CONFIG, ...coerced };

  // When vision is disabled, the vision reservation is forced to 0 so no
  // concurrency slots are wasted on an unused intention.
  if (n.vision_strategy === "never") {
    n.concurrency_vision_reservation = 0;
  }

  for (const rule of FIELD_RULES) {
    errors.push(...rule.errors(n));
  }

  for (const rule of WARNING_RULES) {
    const msg = rule.warning(n);
    if (msg !== null) {
      warnings.push(msg);
    }
  }

  return { ok: errors.length === 0, errors, warnings, normalized: n };
}
