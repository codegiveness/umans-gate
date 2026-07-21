import { VISION_GENERAL_FIELDS, VISION_TUNING_FIELDS } from "@/components/config-vision-fields";
import type { RawConfig } from "@/hooks/use-config";

/**
 * Field helpers.
 * Each field knows how to read/write a primitive value from a RawConfig patch.
 */
type FieldKind =
  | "number"
  | "text"
  | "boolean"
  | "select"
  | "textarea"
  | "password"
  | "toggle"
  | "json";

export interface FieldDef {
  key: keyof RawConfig;
  label: string;
  kind: FieldKind;
  description?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  /** when true, null/empty is a valid value */
  nullable?: boolean;
  restartRequired?: boolean;
  /** when true, field is rendered read-only (user cannot edit) */
  disabled?: boolean;
  /** validation: minimum numeric value */
  min?: number;
  /** validation: maximum numeric value */
  max?: number;
  /** validation: regex pattern for text fields */
  pattern?: string;
  /** validation: human-readable pattern hint shown as placeholder/helper */
  patternHint?: string;
  /** when true, field must be non-empty to pass validation */
  required?: boolean;
  /** input type hint for text inputs: "url", "text", "password" */
  inputMode?: "url" | "text" | "password" | "numeric";
  /** suffix label for input groups, e.g. "ms", "s", "px" */
  suffix?: string;
  /** when true, field is marked as experimental with a badge */
  experimental?: boolean;
  /** when true, show a per-field refresh-from-source icon button */
  refreshSource?: boolean;
  /** when true, field max bounds are sourced from /v1/usage and an "Umans API" badge is shown */
  umansSourced?: boolean;
}

const SERVER_FIELDS: FieldDef[] = [
  {
    key: "port",
    label: "Port",
    kind: "number",
    description: "TCP port the proxy listens on. Range: 1–65,535. Default: 1,945.",
    restartRequired: true,
    required: true,
    min: 1,
    max: 65535,
  },
  {
    key: "max_captures",
    label: "Max Captures",
    kind: "number",
    description:
      "Maximum number of captures kept in the SQLite ring buffer. When this limit is reached, the oldest entries are evicted to make room for new ones. Must be ≥ 200. Default: 200.",
    restartRequired: true,
    required: true,
    min: 200,
  },
  {
    key: "db_path",
    label: "DB Path",
    kind: "text",
    description:
      "Filesystem path to the SQLite database used for storing captures. Relative paths are resolved from the proxy's working directory. Default: ./umans-gate.db.",
    restartRequired: true,
    required: true,
  },
  {
    key: "idle_timeout",
    label: "Idle Timeout",
    kind: "number",
    description:
      "Bun.serve idleTimeout — seconds before an idle HTTP connection is closed. Range: 1–255 (Bun's maximum). Default: 255 s.",
    restartRequired: true,
    required: true,
    min: 1,
    max: 255,
    suffix: "s",
  },
  {
    key: "upstream_protocol",
    label: "Upstream Protocol",
    kind: "select",
    description:
      'HTTP protocol used for upstream connections. "http1.1" uses HTTP/1.1 (default, broadest compatibility); "http2" uses HTTP/2 (multiplexing, lower latency for concurrent requests). Default: http1.1.',
    options: [
      { value: "http1.1", label: "HTTP/1.1" },
      { value: "http2", label: "HTTP/2" },
    ],
    restartRequired: true,
    required: true,
  },
  {
    key: "compression_enabled",
    label: "Compression",
    kind: "toggle",
    restartRequired: false,
    description:
      "When on, stored request/response bodies are compressed with zstd to reduce SQLite database size. Hot-reloadable — changes take effect immediately without restart. Default: on.",
  },
  {
    key: "upstream_timeout_ms",
    label: "Upstream Timeout",
    kind: "number",
    description:
      "Hard timeout for upstream requests in milliseconds. Prevents permit leaks when the upstream hangs and the client stays connected. Must be ≥ 1,000. Default: 300,000 ms (5 min).",
    required: true,
    min: 1000,
    suffix: "ms",
  },
];

const STAMP_FIELDS: FieldDef[] = [
  {
    key: "stamp_claude_code_enabled",
    label: "Claude Code Style",
    kind: "toggle",
    description:
      "When on, applies the full Claude Code stamp bundle on Anthropic requests: cache TTL=1h, temperature=1.0, top_k=20 (GLM only), max_tokens (131,071 GLM / 32,767 others), thinking={type:'adaptive'}, output_config (effort=max GLM / high others), and context_management injection (requires anthropic-version: 2023-06-01). Off by default.",
    experimental: true,
  },
  {
    key: "stamp_reasoning_effort_enabled",
    label: "Reasoning Effort (OpenAI)",
    kind: "toggle",
    description:
      "When on, stamps reasoning_effort='high' onto OpenAI-compatible requests (umans-glm* models get 'max') and removes max_tokens/thinking from the request body. Off by default.",
    experimental: true,
  },
];

const ID_REWRITE_FIELDS: FieldDef[] = [
  {
    key: "experiment_rewrite_ids",
    label: "ID Rewrite",
    kind: "toggle",
    experimental: true,
    description:
      "Parent toggle for the ID rewrite experiment. When on, umans-gate rewrites the x-session-id header and all tool_use_ids (call_*/toolu_*) in the request body when the upstream returns 502/529 with 'overloaded_error', then retries with the rewritten IDs. The rewrites use a per-session salt (stored in SQLite) that escalates on consecutive 502s. This experiment does NOT touch cache_control — existing breakpoints are preserved. Eligible only when the harness is opencode (detected via user-agent). Default: off.",
  },
  {
    key: "experiment_rewrite_ttl_ms",
    label: "Salt TTL",
    kind: "number",
    min: 60000,
    suffix: "ms",
    experimental: true,
    description:
      "Child of experiment_rewrite_ids — only takes effect when the parent toggle is on. Controls how long umans-gate retains the per-session salt mapping in the id_rewrite_sessions SQLite table after the last 502. When the TTL expires, the next 502 starts a fresh salt chain instead of escalating. Default: 3,600,000 ms (1 hour).",
  },
];

const OMO_INTEGRATION_FIELDS: FieldDef[] = [
  {
    key: "experiment_strip_omo_reminder",
    label: "Strip Category+Skill Reminder",
    kind: "toggle",
    experimental: true,
    description:
      "When on, strips oh-my-openagent's Category+Skill Reminder synthetic injection from the first user message before forwarding upstream. This injection (added by the category-skill-reminder hook in oh-my-openagent v4.18.x) splices a 486-byte text block into messages[0] on turn 2, invalidating the prompt cache prefix and causing 0% hit rate for 1-2 turns. Stripping it preserves cache stability. Enable if you use oh-my-openagent and observe cache hit drops on turn 2.",
  },
];

const TTFT_WATCHDOG_FIELDS: FieldDef[] = [
  {
    key: "experiment_ttft_watchdog",
    label: "TTFT Watchdog",
    kind: "toggle",
    experimental: true,
    description:
      "Master toggle for the TTFT (time-to-first-token) watchdog. When on, upstream fetches get a first-byte watchdog that aborts stalled connections within ttft_timeout_ms, then retries (same-key, then rewrite-escalation if eligible). When off (default), the only active guard is the upstream_timeout_ms absolute timeout — no retry, no rewrite. Enable if the upstream intermittently hangs after accepting a request without ever sending the first byte.",
  },
  {
    key: "ttft_timeout_ms",
    label: "TTFT Timeout",
    kind: "number",
    experimental: true,
    description:
      "Watchdog threshold in milliseconds — if no first byte arrives within this window, the fetch is aborted and the retry decision runs. Must be ≥ 1,000. Default: 60,000 ms (1 min).",
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "ttft_retry_max_attempts",
    label: "Max Attempts",
    kind: "number",
    experimental: true,
    description:
      "Cap on total upstream attempts. 1 = original only (no retry). 2 = original + 1 same-key retry. 3 = original + 1 same-key retry + 1 rewrite-id escalation (when eligible). Must be between 1 and 3. Default: 2.",
    required: true,
    min: 1,
    max: 3,
  },
  {
    key: "ttft_retry_gate_saturation_pct",
    label: "Gate Saturation",
    kind: "number",
    experimental: true,
    description:
      "Suppress retry when the gate active count is at or above this percentage of the soft limit. Prevents retries from deepening an already-saturated concurrency gate. Must be between 1 and 100. Default: 80 (%).",
    required: true,
    min: 1,
    max: 100,
    suffix: "%",
  },
  {
    key: "ttft_retry_failure_threshold",
    label: "Failure Threshold",
    kind: "number",
    experimental: true,
    description:
      "Consecutive retry-also-failed events within the failure window that trigger permanent auto-disable of the watchdog (until config reload). Must be ≥ 1. Default: 3.",
    required: true,
    min: 1,
  },
  {
    key: "ttft_retry_failure_window_ms",
    label: "Failure Window",
    kind: "number",
    experimental: true,
    description:
      "Sliding window in milliseconds during which consecutive retry failures are counted toward the auto-disable threshold. Must be ≥ 1,000. Default: 300,000 ms (5 min).",
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "ttft_retry_cooldown_ms",
    label: "Retry Cooldown",
    kind: "number",
    experimental: true,
    description:
      "Delay in milliseconds between retry attempts. Allows the upstream a brief recovery window before the next attempt. Must be ≥ 0. Default: 30,000 ms (30 s).",
    required: true,
    min: 0,
    suffix: "ms",
  },
];

const WARMER_FIELDS: FieldDef[] = [
  {
    key: "warmer_enabled",
    label: "Enabled",
    kind: "boolean",
    description:
      "When on, the proxy periodically pings the upstream /v1/models endpoint to keep connections warm, avoiding ~750 ms cold-start latency on the first request after an idle period. Default: true.",
    restartRequired: true,
  },
  {
    key: "warmer_interval_ms",
    label: "Interval",
    kind: "number",
    description:
      "Interval between upstream keep-alive pings in milliseconds. Shorter intervals keep connections warmer but increase background traffic. Must be ≥ 1,000 ms. Default: 20,000 ms (20 s).",
    restartRequired: true,
    required: true,
    min: 1000,
    suffix: "ms",
  },
];

const CONCURRENCY_GATE_FIELDS: FieldDef[] = [
  {
    key: "use_hard_cap",
    label: "Use Hard Cap",
    kind: "toggle",
    description:
      "When on, the effective concurrency limit is the hard cap (16). When off (default), the effective limit is the soft limit (8). Over-cap is impossible — the gate never grants beyond the selected limit.",
  },
  {
    key: "concurrency_hard_cap",
    label: "Hard Cap",
    kind: "number",
    description:
      "Absolute maximum concurrent upstream requests (16). Non-configurable — derived from /v1/usage. Use the 'Use Hard Cap' toggle to switch the effective limit.",
    disabled: true,
    umansSourced: true,
  },
  {
    key: "concurrency_soft_limit",
    label: "Soft Limit",
    kind: "number",
    description:
      "Soft concurrency limit (8). Non-configurable — derived from /v1/usage. Use the 'Use Hard Cap' toggle to switch the effective limit.",
    disabled: true,
    umansSourced: true,
  },
  {
    key: "concurrency_main_reservation",
    label: "Main Reservation",
    kind: "number",
    description:
      "Number of concurrency slots reserved exclusively for main (non-vision) requests. Ensures vision traffic cannot starve main requests. Must be ≥ 1 and ≤ (hard_cap − 2) when hard_cap ≥ 3. Default: 1.",
    required: true,
    min: 1,
  },
  {
    key: "concurrency_vision_reservation",
    label: "Vision Reservation",
    kind: "number",
    description:
      "Number of concurrency slots reserved exclusively for vision interception requests. When vision_strategy is 'never' this is forced to 0 so no slots are wasted. Otherwise must be ≥ 1 and ≤ (hard_cap − 2) when hard_cap ≥ 3. Default: 1.",
    required: true,
    min: 0,
  },
  {
    key: "release_cooldown_ms",
    label: "Release Cooldown",
    kind: "number",
    description:
      "Delay in milliseconds before releasing a concurrency slot back to the pool after a response completes. A non-zero value adds a brief cooldown to prevent immediate burst re-use. Must be ≥ 0. Default: 1,000 ms (1 s).",
    required: true,
    min: 0,
    suffix: "ms",
  },
  {
    key: "rate_limit_requests",
    label: "Rate Limit",
    kind: "number",
    description:
      "Controls upstream request rate limiting. -1 = unlimited (no limiter at all), 0 = auto-derive the limit from the upstream /v1/usage endpoint (requires umans_api_key), >0 = use this explicit value as the max requests per rate-limit window. Default: 0 (auto-derive).",
    min: -1,
    umansSourced: true,
    refreshSource: true,
  },
];

const CIRCUIT_BREAKER_FIELDS: FieldDef[] = [
  {
    key: "breaker_threshold",
    label: "Breaker Threshold",
    kind: "number",
    description:
      "Number of upstream failures within the breaker window required to open (trip) the circuit breaker. When open, the proxy short-circuits upstream requests instead of retrying. Must be ≥ 1. Default: 5.",
    required: true,
    min: 1,
  },
  {
    key: "breaker_window_ms",
    label: "Breaker Window",
    kind: "number",
    description:
      "Sliding time window in milliseconds during which upstream failures are counted toward the breaker threshold. Must be ≥ 1,000 ms. Default: 300,000 ms (5 minutes).",
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "breaker_cooldown_ms",
    label: "Breaker Cooldown",
    kind: "number",
    description:
      "Duration in milliseconds the circuit breaker stays open before allowing a half-open probe request through. If the probe succeeds, the breaker closes; if it fails, the timer restarts. Must be ≥ 1,000 ms. Default: 60,000 ms (1 minute).",
    required: true,
    min: 1000,
    suffix: "ms",
  },
];

const QUEUE_FIELDS: FieldDef[] = [
  {
    key: "queue_timeout_ms",
    label: "Queue Timeout",
    kind: "number",
    description:
      "Maximum time in milliseconds a request can wait in the concurrency queue before timing out and returning an error to the client. Must be ≥ 100 ms. Default: 30,000 ms (30 s).",
    required: true,
    min: 100,
    suffix: "ms",
  },
  {
    key: "max_queue_depth",
    label: "Max Queue Depth",
    kind: "number",
    description:
      "Maximum number of requests that can be waiting in the concurrency queue simultaneously. When the queue is full, new requests are rejected immediately. Must be ≥ 1. Default: 256.",
    required: true,
    min: 1,
  },
  {
    key: "queue_max_depth",
    label: "Write Queue Depth",
    kind: "number",
    description:
      "Maximum depth of the write-behind database flush queue (distinct from the concurrency waiters queue above). Controls how many capture writes can be buffered before the queue applies backpressure. Must be ≥ 1. Default: 100.",
    min: 1,
  },
];

const CAPTURE_STORAGE_FIELDS: FieldDef[] = [
  {
    key: "capture_body_max_bytes",
    label: "Capture Body Max Bytes",
    kind: "number",
    description:
      "Maximum size (in bytes) of captured request/response bodies stored in SQLite. Bodies exceeding this limit are truncated. 0 = no limit (capture full bodies). Must be ≥ 0. Default: 10,000,000 (10 MB).",
    min: 0,
  },
  {
    key: "ws_backpressure_limit",
    label: "WS Backpressure Limit",
    kind: "number",
    description:
      "Maximum buffered bytes per WebSocket connection before backpressure is applied. When a client falls behind, the proxy stops sending until the client catches up. 0 = use Bun's default limit. Must be ≥ 0. Default: 1,048,576 (1 MB).",
    min: 0,
    suffix: "bytes",
  },
  {
    key: "ws_close_on_backpressure_limit",
    label: "Close on Backpressure Limit",
    kind: "boolean",
    description:
      "When on, WebSocket connections that exceed the backpressure limit are forcibly closed instead of merely pausing. This prevents slow clients from accumulating unbounded buffered data. Default: true.",
  },
];

const CREDENTIALS_FIELDS: FieldDef[] = [
  {
    key: "umans_api_key",
    label: "Umans API Key",
    kind: "password",
    description:
      "Umans API key used to authenticate upstream requests and fetch /v1/usage data (concurrency limits, rate-limit source). When empty, the proxy runs in fail-safe mode with worst-case limits and priority_low=true. Leave empty to disable upstream usage tracking. Default: empty.",
    restartRequired: true,
  },
  {
    key: "usage_refresh_ms",
    label: "Usage Refresh",
    kind: "number",
    description:
      "Interval in milliseconds between background /v1/usage fetches. The usage data drives concurrency limit auto-derivation and rate-limit source values. Shorter intervals keep limits fresher but increase API calls. Must be ≥ 1,000 ms. Default: 60,000 ms (1 minute).",
    restartRequired: true,
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "models_refresh_ms",
    label: "Models Refresh",
    kind: "number",
    description:
      "Interval in milliseconds between background /v1/models fetches. The models list populates the vision model dropdown and validates model names. Must be ≥ 1,000 ms. Default: 3,600,000 ms (1 hour).",
    restartRequired: true,
    required: true,
    min: 1000,
    suffix: "ms",
  },
];

const USAGE_HISTORY_FIELDS: FieldDef[] = [
  {
    key: "usage_history_enabled",
    label: "Usage History",
    kind: "toggle",
    description:
      "When on, every /v1/usage poll is persisted to SQLite (usage_samples + usage_events + usage_daily tables) and the Usage tab visualizes the history. When off, no history is written and the tab shows no data. Hot-reloadable. Default: on.",
  },
  {
    key: "usage_raw_retention_days",
    label: "Raw Retention",
    kind: "number",
    description:
      "Days to retain raw `usage_samples` rows before the downsampling job folds them into a `usage_daily` aggregate and deletes the raw rows. Controls the zoom-in resolution window for the timeline drill-down. Must be ≥ 1. Default: 7.",
    required: true,
    min: 1,
    suffix: "d",
  },
  {
    key: "usage_gap_threshold_minutes",
    label: "Gap Threshold",
    kind: "number",
    description:
      "Minutes between adjacent non-byte-identical samples above which a UTC day is flagged `day_completeness = incomplete_window`. Tune to your machine's sleep behavior so legitimate idle-coalesce gaps (identical adjacent samples) aren't false-positive flagged. Must be ≥ 5. Default: 60.",
    required: true,
    min: 5,
    suffix: "min",
  },
];

export interface SectionDef {
  title: string;
  description: string;
  fields: FieldDef[];
}

export interface GroupDef {
  title: string;
  description: string;
  sections: SectionDef[];
}

export const GROUPS: GroupDef[] = [
  {
    title: "General",
    description: "Core proxy, credentials, vision, and concurrency settings.",
    sections: [
      {
        title: "Server",
        description: "Core network settings and SQLite storage for captures.",
        fields: SERVER_FIELDS,
      },
      {
        title: "Credentials",
        description: "API key and upstream usage/model refresh intervals.",
        fields: CREDENTIALS_FIELDS,
      },
      {
        title: "Vision",
        description: "Vision image-to-description interception pipeline.",
        fields: VISION_GENERAL_FIELDS,
      },
      {
        title: "Warmer",
        description: "Background keep-alive pings to the upstream /v1/models endpoint.",
        fields: WARMER_FIELDS,
      },
      {
        title: "Concurrency & Gate",
        description: "Concurrency limits, reservations, and rate limiting.",
        fields: CONCURRENCY_GATE_FIELDS,
      },
      {
        title: "Usage History",
        description:
          "Persistent /v1/usage history for the Usage tab (heatmap + timeline). All three knobs are hot-reloadable.",
        fields: USAGE_HISTORY_FIELDS,
      },
    ],
  },
  {
    title: "Experimental",
    description: "Optional request-body stamping features that may change behavior.",
    sections: [
      {
        title: "Request Stamp",
        description: "Optional request-body stamping for Anthropic and OpenAI-compatible routes.",
        fields: STAMP_FIELDS,
      },
      {
        title: "ID Rewrite",
        description: "Experimental 502/529 retry with rewritten session/tool_use IDs.",
        fields: ID_REWRITE_FIELDS,
      },
      {
        title: "oh-my-openagent",
        description: "Client-side mitigations for oh-my-openagent harness behaviors.",
        fields: OMO_INTEGRATION_FIELDS,
      },
      {
        title: "TTFT Watchdog",
        description:
          "Experimental first-byte watchdog with gated retry. Aborts stalled upstream fetches and retries (same-key, then rewrite-escalation).",
        fields: TTFT_WATCHDOG_FIELDS,
      },
    ],
  },
  {
    title: "Advanced",
    description: "Circuit breaker, queue tuning, vision parameters, and storage internals.",
    sections: [
      {
        title: "Circuit Breaker",
        description: "Failure detection and circuit breaker thresholds.",
        fields: CIRCUIT_BREAKER_FIELDS,
      },
      {
        title: "Queue",
        description: "Request queue timeouts, depths, and write-behind buffering.",
        fields: QUEUE_FIELDS,
      },
      {
        title: "Vision Tuning",
        description: "Vision prompt, cache, concurrency, and image processing parameters.",
        fields: VISION_TUNING_FIELDS,
      },
      {
        title: "Capture & Storage",
        description: "Body capture limits and WebSocket backpressure controls.",
        fields: CAPTURE_STORAGE_FIELDS,
      },
    ],
  },
];

/** Flat list of all sections across all groups (for validation and lookups). */
export const SECTIONS: SectionDef[] = GROUPS.flatMap((g) => g.sections);
