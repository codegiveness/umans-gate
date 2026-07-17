// Raw config types: the shape of the JSON config file and the input accepted
// by validateConfig/saveConfig (numeric fields accept strings from HTML forms).

/**
 * Fields removed from user config (hardcoded — app is Umans-specific):
 *   target              → "https://api.code.umans.ai"
 *   openai_path         → "chat/completions"
 *   warmer_path         → "/v1/models"
 *   rate_limit_window_seconds → derived from /v1/usage (inherent, not configurable)
 *   vision_target       → derived from target + "/v1/chat/completions"
 *   host                → hardcoded "127.0.0.1" (local-only; use SSH tunnel for remote access)
 */
export interface RawConfig {
  port?: number;
  max_captures?: number;
  db_path?: string;
  idle_timeout?: number;
  upstream_protocol?: string;
  /** When true, applies the full Claude Code stamp bundle on Anthropic requests (TTL, top_k, max_tokens, thinking, output_config, context_management). */
  stamp_claude_code_enabled?: boolean;
  /** When true, stamps reasoning_effort onto OpenAI-compatible requests (effort=max for umans-glm* models, effort=high for all others) and removes max_tokens/thinking. */
  stamp_reasoning_effort_enabled?: boolean;
  warmer_enabled?: boolean;
  warmer_interval_ms?: number;
  umans_api_key?: string;
  /** Optional bearer token for dashboard API authentication. When set, all dashboard API requests must include `Authorization: Bearer <token>`. */
  dashboard_token?: string;
  usage_refresh_ms?: number;
  models_refresh_ms?: number;
  concurrency_hard_cap?: number;
  concurrency_soft_limit?: number;
  /** When true, effective limit = concurrency_hard_cap (16); when false (default), = concurrency_soft_limit (8). */
  use_hard_cap?: boolean;
  /** Pro-tier rolling-window request limit. -1 = unlimited (no limiter), 0 = auto-derive from /v1/usage, >0 = explicit limit. */
  rate_limit_requests?: number;
  queue_timeout_ms?: number;
  max_queue_depth?: number;
  release_cooldown_ms?: number;
  breaker_threshold?: number;
  breaker_window_ms?: number;
  breaker_cooldown_ms?: number;
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
  /** Compress stored request/response bodies with zstd. Default true (on). */
  compression_enabled?: boolean;
  upstream_timeout_ms?: number;
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
