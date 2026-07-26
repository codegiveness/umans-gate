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
  /** When true and stamp_claude_code_enabled is on, stamps GLM 5.2 Preserved Thinking (clear_thinking: false). Only applies to models whose name contains "5.2". Default false. */
  stamp_glm_5_2_thinking_enabled?: boolean;
  /** When true and stamp_claude_code_enabled is on, stamps Kimi K2.7-Code Preserved Thinking (keep: "all"). Only applies to models whose name contains "k2.7-code". Default false. */
  stamp_kimi_k2_7_code_thinking_enabled?: boolean;
  /** When true, stamps reasoning_effort onto OpenAI-compatible requests (effort=max for umans-glm* models, effort=high for all others) and removes max_tokens/thinking. */
  stamp_reasoning_effort_enabled?: boolean;
  warmer_enabled?: boolean;
  warmer_interval_ms?: number;
  umans_api_key?: string;
  /** Optional bearer token for dashboard API authentication. When set, all dashboard API requests must include `Authorization: Bearer <token>`. */
  dashboard_token?: string;
  usage_refresh_ms?: number;
  /** When true, persists coalesced /v1/usage snapshots to the usage_samples table for the Usage dashboard tab. Hot-reloadable. */
  usage_history_enabled?: boolean;
  /** Raw usage_samples retention in days. Older rows are pruned by the daily downsampling job. Hot-reloadable. */
  usage_raw_retention_days?: number;
  /** Gap threshold in minutes for marking a UTC day as incomplete_window. Hot-reloadable. */
  usage_gap_threshold_minutes?: number;
  /** Idle session timeout in minutes. Consecutive open-session intervals with no token movement exceeding this are treated as idle (not counted as active). Hot-reloadable. */
  usage_idle_session_timeout_minutes?: number;
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
  /** Intent-aware vision strategy (Task 9): gates HOW to prompt the vision model once `vision_strategy` has decided to intercept. "off" = generic only, "slotted"/"crafted" = force that strategy, "auto" = triage decides per-request. */
  vision_intent_strategy?: "off" | "slotted" | "crafted" | "auto";
  /** Whether multi-image decomposition (DecoVQA+) is enabled. */
  vision_decomposition_enabled?: boolean;
  /** Timeout for the decomposition LLM call, in ms. */
  vision_decomposition_timeout_ms?: number;
  /** Timeout for the crafting LLM call (Strategy D), in ms. */
  vision_crafting_timeout_ms?: number;
  /** Max chars to extract from adjacent text blocks (VisionContext.adjacentText). */
  vision_adjacent_text_max_chars?: number;
  /** Number of recent user messages to include in VisionContext.recentMessages. */
  vision_recent_messages_count?: number;
  /** Max chars to extract from the original system prompt. */
  vision_system_prompt_max_chars?: number;
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
  /** EXPERIMENTAL: Rewrite opencode session IDs and tool_use_ids on 502 retry. Default false. */
  experiment_rewrite_ids?: boolean;
  /** EXPERIMENTAL: TTL in ms for id_rewrite_sessions entries. Default 3600000 (1 hour). */
  experiment_rewrite_ttl_ms?: number;
  /** EXPERIMENTAL: Strip oh-my-openagent's [Category+Skill Reminder] injection from request bodies before forwarding upstream. Default false. */
  experiment_strip_omo_reminder?: boolean;
  /** EXPERIMENTAL: Master toggle for TTFT-watchdog gated retry. When true, upstream fetches get a first-byte watchdog that aborts stalled connections within ttft_timeout_ms. Default false. */
  experiment_ttft_watchdog?: boolean;
  /** Watchdog threshold in ms. If no first byte arrives within this window, the fetch is aborted. Default 60000 (60s). */
  ttft_timeout_ms?: number;
  /** Cap on total upstream attempts. 2 = original + 1 same-key retry. 3 = original + 1 same-key retry + 1 rewrite-id escalation (when eligible). Default 2. */
  ttft_retry_max_attempts?: number;
  /** Suppress retry when gate active count >= this percentage of the soft limit. Default 80. */
  ttft_retry_gate_saturation_pct?: number;
  /** Window in ms for counting consecutive retry-also-failed events before auto-disable. Default 300000 (5 min). */
  ttft_retry_failure_window_ms?: number;
  /** Consecutive retry-also-failed events within the window that trigger auto-disable. Default 3. */
  ttft_retry_failure_threshold?: number;
  /** Cooldown between retries in ms. Default 30000 (30s). */
  ttft_retry_cooldown_ms?: number;
  /** Number of latest captures per model used for performance percentile computation. Decoupled from max_captures. Hot-reloadable. Default 200. */
  performance_sample_count?: number;
  /** Days to retain incident rows. Default 30. Minimum 1. Hot-reloadable. */
  incident_retention_days?: number;
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
