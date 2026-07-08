// Configuration: JSON config file (single source of truth) + env overrides.
// Config path resolution (cross-OS):
//   Linux/macOS: $XDG_CONFIG_HOME/umans-gate/config.json  or  ~/.config/umans-gate/config.json
//   Windows:     %APPDATA%/umans-gate/config.json
// Precedence: env vars > JSON config file > built-in defaults.
// On first run, a config.json is written to the resolved path.
// If a legacy config.yml exists, it is migrated to config.json (one-time).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import type {
  IncomingProtocol,
  OutputConfig,
  ProxyConfig,
  ThinkingConfig,
  UpstreamProtocol,
} from "./types.js";

/** Resolve the config directory path following OS conventions. */
export function resolveConfigDir(): string {
  const p = platform();
  if (p === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "umans-gate");
  }
  // Linux, macOS, and fallback.
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "umans-gate");
}

/** Resolve the config file path (JSON single source of truth). */
export function resolveConfigPath(): string {
  return join(resolveConfigDir(), "config.json");
}

/** Resolve the legacy YAML config path (used for migration only). */
export function resolveLegacyYamlPath(): string {
  return join(resolveConfigDir(), "config.yml");
}

/**
 * Fields removed from user config (hardcoded — app is Umans-specific):
 *   target              → "https://api.code.umans.ai"
 *   openai_path         → "chat/completions"
 *   warmer_path         → "/v1/models"
 *   rate_limit_window_seconds → derived from /v1/usage (inherent, not configurable)
 *   vision_target       → derived from target + "/v1/chat/completions"
 *   stamp_cache_ttl     → replaced by stamp_cache_ttl_enabled (toggle)
 *   stamp_top_k         → replaced by stamp_top_k_enabled (toggle)
 */
export interface RawConfig {
  port?: number;
  host?: string;
  max_captures?: number;
  db_path?: string;
  idle_timeout?: number;
  upstream_protocol?: string;
  /** Experimental toggle: when true, stamps TTL=1h onto Anthropic ephemeral cache_control blocks. Default false (off). */
  stamp_cache_ttl_enabled?: boolean;
  /** Experimental toggle: when true, stamps top_k=20 onto requests. Default false (off). */
  stamp_top_k_enabled?: boolean;
  /** Experimental toggle: when true, stamps max_tokens=32000 onto Anthropic requests. Default false (off). */
  stamp_max_tokens_enabled?: boolean;
  /** Experimental toggle: when true, stamps thinking block onto Anthropic requests. Default false (off). */
  stamp_thinking_enabled?: boolean;
  /** Experimental toggle: when true, stamps output_config onto Anthropic requests (effort=max for umans-glm* models, effort=high for all others). Default false (off). */
  stamp_output_config_enabled?: boolean;
  /** Experimental toggle: when true, stamps reasoning_effort onto OpenAI-compatible requests (effort=max for umans-glm* models, effort=high for all others) and removes max_tokens/thinking. Default false (off). */
  stamp_reasoning_effort_enabled?: boolean;
  warmer_enabled?: boolean;
  warmer_interval_ms?: number;
  umans_api_key?: string;
  usage_refresh_ms?: number;
  models_refresh_ms?: number;
  concurrency_hard_cap?: number;
  concurrency_soft_limit?: number;
  concurrency_weights?: Record<string, number>;
  /** Pro-tier rolling-window request limit. 0 = disabled. If null/unset, derived from /v1/usage. */
  rate_limit_requests?: number;
  queue_timeout_ms?: number;
  max_queue_depth?: number;
  release_cooldown_ms?: number;
  breaker_threshold?: number;
  breaker_window_ms?: number;
  breaker_cooldown_ms?: number;
  usage_stats_latest_n?: number;
  vision_strategy?: "never" | "catalog" | "always";
  vision_model?: string;
  vision_prompt?: string;
  vision_prompt_version?: number;
  vision_max_images?: number;
  vision_max_description_tokens?: number;
  vision_reasoning_effort?: "none" | "low" | "medium" | "high" | null;
  vision_timeout_ms?: number;
  vision_cache_size?: number;
  vision_cache_ttl_ms?: number;
  vision_cache_max_rows?: number;
  vision_persistent_cache?: boolean;
  vision_concurrency?: number;
  vision_max_dimension?: number;
  vision_jpeg_quality?: number;
  vision_image_format?: "jpeg" | "png";
  vision_image_detail?: "auto" | "low" | "high";
  concurrency_main_reservation?: number;
  concurrency_vision_reservation?: number;
  vision_api_key?: string;
  vision_force_intercept_capable?: boolean;
  /** Max captured request/response body size in bytes. 0 = unlimited. */
  capture_body_max_bytes?: number;
  /** Max depth of the write-behind response queue. Distinct from waiters queue. */
  queue_max_depth?: number;
  /** WebSocket backpressure limit in bytes. 0 = use Bun default. */
  ws_backpressure_limit?: number;
  /** Close WebSocket connections that exceed the backpressure limit. */
  ws_close_on_backpressure_limit?: boolean;
  /** Max pending vision requests to batch together. */
  vision_pending_max_batch?: number;
}

/**
 * Input shape accepted by validateConfig/saveConfig. Numeric fields accept
 * strings because HTML form inputs and env vars produce strings. Coercion
 * to RawConfig happens inside validateConfig.
 */
export type RawConfigInput = {
  [K in keyof RawConfig]?: NonNullable<RawConfig[K]> extends number
    ? RawConfig[K] | string
    : RawConfig[K];
};

/** Hardcoded constants — app is Umans-specific, not user-configurable. */
export const UPSTREAM_TARGET = "https://api.code.umans.ai";
export const OPENAI_CHAT_PATH = "chat/completions";
export const WARMER_PATH = "/v1/models";
/** Vision target derived from upstream target. */
export const VISION_TARGET_PATH = "/v1/chat/completions";
/** Stamp TTL value used when stamp_cache_ttl_enabled is true. */
export const STAMP_CACHE_TTL_VALUE = "1h";
/** Top-K value used when stamp_top_k_enabled is true. */
export const STAMP_TOP_K_VALUE = 20;
/** Thinking block injected when stamp_thinking_enabled is true. */
export const STAMP_THINKING_VALUE: ThinkingConfig = {
  type: "adaptive",
};

/** max_tokens value injected when stamp_max_tokens_enabled is true. */
export const STAMP_MAX_TOKENS_VALUE = 32000;

/** output_config value injected when stamp_output_config_enabled is true. */
export const STAMP_OUTPUT_CONFIG_VALUE: OutputConfig = {
  effort: "high",
};

/** output_config value injected for umans-glm* models when stamp_output_config_enabled is true. */
export const STAMP_OUTPUT_CONFIG_GLM_VALUE: OutputConfig = {
  effort: "max",
};

export const STAMP_REASONING_EFFORT_VALUE = "high" as const;
export const STAMP_REASONING_EFFORT_GLM_VALUE = "max" as const;

/** The default config written on first run. */
const DEFAULT_CONFIG: RawConfig = {
  port: 9000,
  host: "0.0.0.0",
  max_captures: 200,
  db_path: "./umans-gate.db",
  idle_timeout: 255,
  upstream_protocol: "http1.1",
  stamp_cache_ttl_enabled: false,
  stamp_top_k_enabled: false,
  stamp_max_tokens_enabled: false,
  stamp_thinking_enabled: false,
  stamp_output_config_enabled: false,
  stamp_reasoning_effort_enabled: false,
  warmer_enabled: true,
  warmer_interval_ms: 20000,
  umans_api_key: "",
  usage_refresh_ms: 60000,
  models_refresh_ms: 3600000,
  concurrency_hard_cap: 1,
  concurrency_soft_limit: 1,
  concurrency_weights: { Qwen: 0.5 },
  rate_limit_requests: 0,
  queue_timeout_ms: 30000,
  max_queue_depth: 256,
  release_cooldown_ms: 1000,
  breaker_threshold: 5,
  breaker_window_ms: 300000,
  breaker_cooldown_ms: 60000,
  usage_stats_latest_n: 200,
  vision_strategy: "always",
  vision_model: "umans-flash",
  vision_prompt:
    "You are an expert visual analyst with perfect vision and meticulous attention to detail. Your task is to produce an exhaustive, accurate description of an image for a downstream text-only language model that cannot see the image.\n\nStructure your description as:\n\n1. IMAGE TYPE: What kind of image is this (photograph, screenshot, diagram, chart, illustration, document scan, UI mockup, etc.)?\n\n2. OVERALL CONTENT: A comprehensive summary of everything visible.\n\n3. TEXT/OCR: Transcribe ALL visible text exactly as written, preserving:\n   - Original spelling, formatting, and hierarchy\n   - Line breaks and spatial layout\n   - Numbers, codes, identifiers, and labels\n   - Captions, watermarks, signatures\n   If text is partially visible, transcribe what you can and mark gaps with [...].\n\n4. VISUAL ELEMENTS: Describe in detail:\n   - Objects, people, and their positions/relationships\n   - Colors, shapes, textures\n   - Spatial layout and composition\n   - UI elements (buttons, menus, fields, tabs) if a screenshot\n\n5. DATA/CHARTS: If charts, tables, or data visualizations are present:\n   - Chart type and axes\n   - Data values, ranges, and trends\n   - Table structure and cell contents\n\n6. CONTEXTUAL CLUES: Date/time indicators, language, cultural context, technical domain indicators.\n\n7. QUALITY NOTES: Any blur, artifacts, obstructions, or ambiguity.\n\nRules:\n- Describe what is VISIBLE, not what you infer.\n- Be exhaustive: omit nothing visible. When in doubt, include it.\n- For uncertain elements, state your uncertainty rather than guessing.\n- Do not summarize or abbreviate.\n- Output only the description, no preamble.",
  vision_prompt_version: 2,
  vision_max_images: 5,
  vision_max_description_tokens: 4096,
  vision_reasoning_effort: "none",
  vision_timeout_ms: 0,
  vision_cache_size: 1000,
  vision_cache_ttl_ms: 604800000,
  vision_cache_max_rows: 10000,
  vision_persistent_cache: true,
  vision_concurrency: 1,
  vision_max_dimension: 2048,
  vision_jpeg_quality: 92,
  vision_image_format: "png",
  vision_image_detail: "high",
  concurrency_main_reservation: 1,
  concurrency_vision_reservation: 1,
  vision_api_key: "",
  vision_force_intercept_capable: false,
  capture_body_max_bytes: 1_000_000,
  queue_max_depth: 100,
  ws_backpressure_limit: 1_048_576,
  ws_close_on_backpressure_limit: true,
  vision_pending_max_batch: 50,
};

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
const INT_FIELDS: (keyof RawConfig)[] = [
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
  "usage_stats_latest_n",
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
];

/**
 * Coerce a raw config patch so that numeric strings become numbers and empty
 * strings for nullable fields become null. HTML form inputs always produce
 * strings; without this, Number.isInteger("7777") === false and validation
 * rejects every numeric field the UI sends.
 *
 * Returns a new object; does not mutate the input.
 */
function coerceRawForValidation(raw: RawConfigInput): RawConfig {
  const out = { ...raw } as Record<string, unknown>;
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

interface FieldRule {
  name: string;
  errors: (n: RawConfig) => string[];
}

interface WarningRule {
  name: string;
  warning: (n: RawConfig) => string | null;
}
const FIELD_RULES: FieldRule[] = [
  {
    name: "port",
    errors: (n) =>
      n.port !== undefined && (!Number.isInteger(n.port) || n.port < 1 || n.port > 65535)
        ? ["port must be an integer between 1 and 65535"]
        : [],
  },
  {
    name: "host",
    errors: (n) =>
      n.host !== undefined && (typeof n.host !== "string" || n.host.length === 0)
        ? ["host must be a non-empty string"]
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
    errors: (n) =>
      n.db_path !== undefined && (typeof n.db_path !== "string" || n.db_path.length === 0)
        ? ["db_path must be a non-empty string"]
        : [],
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
    [
      "stamp_cache_ttl_enabled",
      "stamp_top_k_enabled",
      "stamp_thinking_enabled",
      "stamp_max_tokens_enabled",
      "stamp_output_config_enabled",
      "stamp_reasoning_effort_enabled",
    ] as const
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
    // Cross-field: only checked when hard_cap is an integer >= 2.
    name: "concurrency_main_reservation",
    errors: (n) => {
      if (
        n.concurrency_hard_cap === undefined ||
        !Number.isInteger(n.concurrency_hard_cap) ||
        n.concurrency_main_reservation === undefined
      ) {
        return [];
      }
      const resMax = n.concurrency_hard_cap - 1;
      if (resMax < 1) return [];
      if (!Number.isInteger(n.concurrency_main_reservation) || n.concurrency_main_reservation < 1) {
        return ["concurrency_main_reservation must be a positive integer (min 1)"];
      }
      if (n.concurrency_main_reservation > resMax) {
        return [`concurrency_main_reservation must be <= hard_cap - 1 (=${resMax})`];
      }
      return [];
    },
  },
  {
    // Cross-field: only checked when hard_cap is an integer >= 2.
    name: "concurrency_vision_reservation",
    errors: (n) => {
      if (
        n.concurrency_hard_cap === undefined ||
        !Number.isInteger(n.concurrency_hard_cap) ||
        n.concurrency_vision_reservation === undefined
      ) {
        return [];
      }
      const resMax = n.concurrency_hard_cap - 1;
      if (resMax < 1) return [];
      if (
        !Number.isInteger(n.concurrency_vision_reservation) ||
        n.concurrency_vision_reservation < 1
      ) {
        return ["concurrency_vision_reservation must be a positive integer (min 1)"];
      }
      if (n.concurrency_vision_reservation > resMax) {
        return [`concurrency_vision_reservation must be <= hard_cap - 1 (=${resMax})`];
      }
      return [];
    },
  },
  {
    name: "concurrency_weights",
    errors: (n) => {
      if (n.concurrency_weights === undefined) return [];
      if (typeof n.concurrency_weights !== "object" || n.concurrency_weights === null) {
        return ["concurrency_weights must be an object"];
      }
      const out: string[] = [];
      for (const [k, v] of Object.entries(n.concurrency_weights)) {
        if (typeof v !== "number" || v <= 0) {
          out.push(`concurrency_weights.${k} must be a positive number`);
        }
      }
      return out;
    },
  },
  {
    name: "rate_limit_requests",
    errors: (n) =>
      n.rate_limit_requests !== undefined &&
      n.rate_limit_requests !== null &&
      (!Number.isInteger(n.rate_limit_requests) || n.rate_limit_requests < 0)
        ? [
            "rate_limit_requests must be a non-negative integer (0 = disabled, null = derive from /v1/usage)",
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
    name: "usage_stats_latest_n",
    errors: (n) =>
      n.usage_stats_latest_n !== undefined &&
      (!Number.isInteger(n.usage_stats_latest_n) || n.usage_stats_latest_n < 1)
        ? ["usage_stats_latest_n must be a positive integer"]
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
    name: "vision_api_key",
    errors: (n) =>
      n.vision_api_key !== undefined && typeof n.vision_api_key !== "string"
        ? ["vision_api_key must be a string"]
        : [],
  },
  {
    name: "vision_force_intercept_capable",
    errors: (n) =>
      n.vision_force_intercept_capable !== undefined &&
      typeof n.vision_force_intercept_capable !== "boolean"
        ? ["vision_force_intercept_capable must be a boolean"]
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

const WARNING_RULES: WarningRule[] = [
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
      n.rate_limit_requests === 0 ? "Rate limiting is disabled (rate_limit_requests=0)" : null,
  },
  {
    name: "stamp_cache_ttl_off",
    warning: (n) =>
      n.stamp_cache_ttl_enabled !== true
        ? "Cache TTL stamping is off (experimental) — ephemeral cache entries will have no default TTL"
        : null,
  },
  {
    name: "umans_api_key_empty",
    warning: (n) =>
      n.umans_api_key === "" || n.umans_api_key === undefined
        ? "umans_api_key is empty — proxy runs in fail-safe mode (worst-case limits, priority_low=true)"
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

/**
 * Migrate legacy config.yml → config.json (one-time).
 * If config.yml exists and config.json does not, parse YAML and write JSON.
 * The YAML file is NOT deleted (user may want it as backup).
 */
export function migrateFromYamlIfNeeded(): boolean {
  const jsonPath = resolveConfigPath();
  const ymlPath = resolveLegacyYamlPath();
  if (!existsSync(ymlPath) || existsSync(jsonPath)) return false;
  try {
    const text = readFileSync(ymlPath, "utf-8");
    const parsed = (parse(text) ?? {}) as RawConfig;
    writeFileSync(jsonPath, JSON.stringify(parsed, null, 2), "utf-8");
    return true;
  } catch {
    // If migration fails, fall through to ensureConfigFile which creates defaults.
    return false;
  }
}

/**
 * Write the default config template if no config file exists.
 * Migrates from legacy YAML if present.
 */
export function ensureConfigFile(): string {
  const path = resolveConfigPath();
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    migrateFromYamlIfNeeded();
    // If migration didn't create it, write defaults.
    if (!existsSync(path)) {
      writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf-8");
    }
  }
  return path;
}

function resolveUpstreamProtocol(raw: string | undefined): UpstreamProtocol {
  const v = (raw ?? "http1.1").toLowerCase();
  if (v === "http2" || v === "h2") return "http2";
  return "http1.1";
}

function num(val: number | string | undefined | null, fallback: number): number {
  if (val === undefined || val === null) return fallback;
  const n = Number(val);
  return Number.isNaN(n) ? fallback : n;
}

function str(val: string | undefined, fallback: string): string {
  return val ?? fallback;
}

function loadJsonConfig(path: string): RawConfig {
  if (!existsSync(path)) return {};
  try {
    const text = readFileSync(path, "utf-8");
    const parsed = JSON.parse(text) as RawConfig;
    return parsed ?? {};
  } catch {
    return {};
  }
}

/**
 * Coerce a raw config value to a boolean from various input shapes.
 * Accepts true/false, "true"/"false", 1/0.
 */
function bool(val: unknown, fallback: boolean): boolean {
  if (val === undefined || val === null) return fallback;
  if (typeof val === "boolean") return val;
  if (typeof val === "string") return val === "true" || val === "1";
  if (typeof val === "number") return val !== 0;
  return fallback;
}

function envOrRawNum(
  envVal: string | undefined,
  raw: RawConfig,
  key: keyof RawConfig,
  fallback: number,
): number {
  if (envVal !== undefined) return num(envVal, fallback);
  const rawVal = raw[key];
  return typeof rawVal === "number" && !Number.isNaN(rawVal) ? rawVal : fallback;
}

function envOrRawBool(
  envVal: string | undefined,
  raw: RawConfig,
  key: keyof RawConfig,
  fallback: boolean,
): boolean {
  if (envVal !== undefined) return bool(envVal, fallback);
  const rawVal = raw[key];
  return typeof rawVal === "boolean" ? rawVal : fallback;
}

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

  const port = num(env.PORT ?? raw.port, 9000);
  const host = str(env.HOST ?? raw.host, "0.0.0.0");
  const target = (env.TARGET ?? UPSTREAM_TARGET).replace(/\/+$/, "");
  const maxCaptures = num(env.MAX_CAPTURES ?? raw.max_captures, 200);
  const dbPath = str(env.DB_PATH ?? raw.db_path, "./umans-gate.db");
  const idleTimeout = Math.min(num(env.IDLE_TIMEOUT ?? raw.idle_timeout, 255), 255);
  const upstreamProtocol = resolveUpstreamProtocol(env.UPSTREAM_PROTOCOL ?? raw.upstream_protocol);
  const stampCacheTtlEnabled = bool(
    env.STAMP_CACHE_TTL_ENABLED ?? raw.stamp_cache_ttl_enabled,
    false,
  );
  const stampTtl = stampCacheTtlEnabled ? STAMP_CACHE_TTL_VALUE : null;
  const stampTopKEnabled = bool(env.STAMP_TOP_K_ENABLED ?? raw.stamp_top_k_enabled, false);
  const stampTopK = stampTopKEnabled ? STAMP_TOP_K_VALUE : null;
  const stampMaxTokensEnabled = bool(
    env.STAMP_MAX_TOKENS_ENABLED ?? raw.stamp_max_tokens_enabled,
    false,
  );
  const stampMaxTokens = stampMaxTokensEnabled ? STAMP_MAX_TOKENS_VALUE : null;
  const stampThinkingEnabled = bool(
    env.STAMP_THINKING_ENABLED ?? raw.stamp_thinking_enabled,
    false,
  );
  const stampThinking = stampThinkingEnabled ? STAMP_THINKING_VALUE : null;
  const stampOutputConfigEnabled = bool(
    env.STAMP_OUTPUT_CONFIG_ENABLED ?? raw.stamp_output_config_enabled,
    false,
  );
  const stampOutputConfig = stampOutputConfigEnabled ? STAMP_OUTPUT_CONFIG_VALUE : null;
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
  const usageRefreshMs = num(env.USAGE_REFRESH_MS ?? raw.usage_refresh_ms, 60000);
  const modelsRefreshMs = num(env.MODELS_REFRESH_MS ?? raw.models_refresh_ms, 3600000);
  const concurrencyHardCap = num(env.CONCURRENCY_HARD_CAP ?? raw.concurrency_hard_cap, 1);
  const concurrencySoftLimit = num(env.CONCURRENCY_SOFT_LIMIT ?? raw.concurrency_soft_limit, 1);
  const concurrencyWeights = raw.concurrency_weights ?? {};
  const rateLimitRequests = num(env.RATE_LIMIT_REQUESTS ?? raw.rate_limit_requests, 0);
  const queueTimeoutMs = num(env.QUEUE_TIMEOUT_MS ?? raw.queue_timeout_ms, 30000);
  const maxQueueDepth = num(env.MAX_QUEUE_DEPTH ?? raw.max_queue_depth, 256);
  const releaseCooldownMs = num(env.RELEASE_COOLDOWN_MS ?? raw.release_cooldown_ms, 1000);
  const breakerThreshold = num(env.BREAKER_THRESHOLD ?? raw.breaker_threshold, 5);
  const breakerWindowMs = num(env.BREAKER_WINDOW_MS ?? raw.breaker_window_ms, 300000);
  const breakerCooldownMs = num(env.BREAKER_COOLDOWN_MS ?? raw.breaker_cooldown_ms, 60000);
  const usageStatsLatestN = num(env.USAGE_STATS_LATEST_N ?? raw.usage_stats_latest_n, 200);

  const visionStrategy = str(env.VISION_STRATEGY ?? raw.vision_strategy, "always") as
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
  const concurrencyMainReservation = num(
    env.CONCURRENCY_MAIN_RESERVATION ?? raw.concurrency_main_reservation,
    1,
  );
  const concurrencyVisionReservation = num(
    env.CONCURRENCY_VISION_RESERVATION ?? raw.concurrency_vision_reservation,
    1,
  );
  const visionApiKey = env.VISION_API_KEY || raw.vision_api_key || null;

  const visionForceInterceptCapable =
    env.VISION_FORCE_INTERCEPT_CAPABLE === "true" ||
    (env.VISION_FORCE_INTERCEPT_CAPABLE === undefined &&
      raw.vision_force_intercept_capable === true);

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
    stampTtl,
    stampTopK,
    stampMaxTokens,
    stampThinking,
    stampOutputConfig,
    stampReasoningEffort,
    openaiPath,
    warmerEnabled,
    warmerIntervalMs,
    warmerPath,
    umansApiKey,
    usageRefreshMs,
    modelsRefreshMs,
    concurrencyHardCap,
    concurrencySoftLimit,
    concurrencyWeights,
    rateLimitRequests,
    queueTimeoutMs,
    maxQueueDepth,
    releaseCooldownMs,
    breakerThreshold,
    breakerWindowMs,
    breakerCooldownMs,
    usageStatsLatestN,
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
    concurrencyMainReservation,
    concurrencyVisionReservation,
    visionApiKey,
    visionForceInterceptCapable,
    captureBodyMaxBytes,
    queueMaxDepth,
    wsBackpressureLimit,
    wsCloseOnBackpressureLimit,
    visionPendingMaxBatch,
  };
}

/**
 * Read the raw config.json from disk (for the config UI).
 * Returns defaults merged with the file contents (no env override).
 */
export function readConfigFile(): RawConfig {
  const path = ensureConfigFile();
  const raw = loadJsonConfig(path);
  return { ...DEFAULT_CONFIG, ...raw };
}

/**
 * Save a partial config to disk (validate first, merge with existing).
 * Returns validation result + the merged config that was written.
 */
export function saveConfig(patch: RawConfigInput): {
  ok: boolean;
  errors: string[];
  warnings: string[];
  written: RawConfig | null;
} {
  const existing = readConfigFile();
  const merged: RawConfig = { ...existing, ...coerceRawForValidation(patch) };
  const result = validateConfig(merged);
  if (!result.ok) {
    return { ok: false, errors: result.errors, warnings: result.warnings, written: null };
  }
  const path = resolveConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(result.normalized, null, 2), "utf-8");
  return { ok: true, errors: [], warnings: result.warnings, written: result.normalized };
}

/**
 * Fields that require a server restart to take effect (cannot be hot-reloaded).
 * Everything else can be applied to the live ProxyConfig in-place via reloadConfig().
 */
const RESTART_REQUIRED_FIELDS = new Set<keyof RawConfig>([
  "port",
  "host",
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
  "vision_api_key",
  "vision_force_intercept_capable",
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
    rawKey: "stamp_cache_ttl_enabled",
    apply: (live, fresh) => {
      live.stampTtl = fresh.stampTtl;
    },
  },
  {
    rawKey: "stamp_top_k_enabled",
    apply: (live, fresh) => {
      live.stampTopK = fresh.stampTopK;
    },
  },
  {
    rawKey: "stamp_thinking_enabled",
    apply: (live, fresh) => {
      live.stampThinking = fresh.stampThinking;
    },
  },
  {
    rawKey: "stamp_max_tokens_enabled",
    apply: (live, fresh) => {
      live.stampMaxTokens = fresh.stampMaxTokens;
    },
  },
  {
    rawKey: "stamp_output_config_enabled",
    apply: (live, fresh) => {
      live.stampOutputConfig = fresh.stampOutputConfig;
    },
  },
  {
    rawKey: "stamp_reasoning_effort_enabled",
    apply: (live, fresh) => {
      live.stampReasoningEffort = fresh.stampReasoningEffort;
    },
  },
  {
    rawKey: "concurrency_weights",
    apply: (live, fresh) => {
      live.concurrencyWeights = fresh.concurrencyWeights;
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
    rawKey: "usage_stats_latest_n",
    apply: (live, fresh) => {
      live.usageStatsLatestN = fresh.usageStatsLatestN;
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
