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
  /** optional tooltip text shown next to the field label via an info icon */
  tooltip?: string;
  /** when set, field is disabled when the referenced field's value is falsy */
  dependsOn?: keyof RawConfig;
}

const SERVER_FIELDS: FieldDef[] = [
  {
    key: "port",
    label: "Port",
    kind: "number",
    description: "TCP port the proxy listens on. Default: 1,945.",
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
      "Maximum captures retained in the SQLite ring buffer. Oldest evicted when full. Default: 200.",
    restartRequired: true,
    required: true,
    min: 200,
  },
  {
    key: "db_path",
    label: "DB Path",
    kind: "text",
    description:
      "SQLite database path for captures. Relative paths resolve from the working directory. Default: ./umans-gate.db.",
    restartRequired: true,
    required: true,
  },
  {
    key: "idle_timeout",
    label: "Idle Timeout",
    kind: "number",
    description:
      "Bun.serve idleTimeout — seconds before an idle HTTP connection closes. Max 255 (Bun limit). Default: 255 s.",
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
      "HTTP protocol for upstream connections. http1.1 (default, broadest compat) or http2 (multiplexing, lower latency under concurrency). Default: http1.1.",
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
      "zstd-compresses stored request/response bodies to reduce SQLite database size. Default: on.",
  },
  {
    key: "upstream_timeout_ms",
    label: "Upstream Timeout",
    kind: "number",
    description:
      "Hard timeout for upstream requests. Prevents permit leaks when upstream hangs and client stays connected. Default: 300,000 ms (5 min).",
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "performance_sample_count",
    label: "Performance Sample Count",
    kind: "number",
    description:
      "Latest captures per model used for performance percentile computation in the Performance tab. Decoupled from Max Captures. Default: 200.",
    min: 10,
    max: 10000,
    suffix: "rows",
  },
];

const STAMP_FIELDS: FieldDef[] = [
  {
    key: "stamp_claude_code_enabled",
    label: "Claude Code Style",
    kind: "toggle",
    description:
      "When on, stamps Anthropic routes: TTL=1h on cache_control ephemeral blocks (always, independent of thinking), plus when thinking is enabled — temperature=1.0, top_k=20 (GLM only), max_tokens (131,071 GLM / 32,767 others), thinking forced to {type:'adaptive'}, output_config (effort=max GLM / high others), context_management injection. Disabled thinking is respected unless policy.canDisableThinking=false (Kimi, Coder). Default: off.",
    experimental: true,
  },
  {
    key: "stamp_glm_5_2_thinking_enabled",
    label: "GLM 5.2 Preserved Thinking",
    kind: "toggle",
    description:
      "When on (and Claude Code Style is on), stamps GLM 5.2 Preserved Thinking (clear_thinking: false) on models whose name contains '5.2'. Z.ai docs: 'Preserved Thinking retains reasoning content across turns — set clear_thinking: false and return unmodified reasoning_content.' When off, falls back to {type: 'adaptive'}. Only affects thinkingShape — TTL, top_k, max_tokens, output_config, context_management continue per parent overlay. Default: off.",
    experimental: true,
    dependsOn: "stamp_claude_code_enabled",
  },
  {
    key: "stamp_kimi_k2_7_code_thinking_enabled",
    label: "Kimi K2.7-Code Preserved Thinking",
    kind: "toggle",
    description:
      'When on (and Claude Code Style is on), stamps Kimi K2.7-Code Preserved Thinking (keep: "all") on models whose name contains \'k2.7-code\'. Moonshot docs: \'kimi-k2.7-code: thinking is always on, Preserved Thinking is always on. Only {"type":"enabled","keep":"all"} is accepted; any other configuration returns an error.\' When off, falls back to {type: \'adaptive\'}. Default: off.',
    experimental: true,
    dependsOn: "stamp_claude_code_enabled",
  },
  {
    key: "stamp_reasoning_effort_enabled",
    label: "Reasoning Effort (OpenAI)",
    kind: "toggle",
    description:
      "When on, stamps reasoning_effort on OpenAI-compatible routes from policy (effort=max for GLM, high for others). Injects when thinking is enabled or reasoning_effort is present; respects absent fields and disabled values (off/none/null) when canDisableThinking=true. When active: strips thinking, output_config, context_management; forces temperature=1.0 (reasoning models reject temperature != 1.0). Default: off.",
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
      "Parent toggle for ID rewrite experiment. On 502/529 'overloaded_error', rewrites x-session-id header and tool_use_ids (call_*/toolu_*) using a per-session salt (stored in SQLite) that escalates on consecutive 502s, then retries. Preserves cache_control breakpoints. Eligible only when harness is opencode (detected via user-agent). Default: off.",
  },
  {
    key: "experiment_rewrite_ttl_ms",
    label: "Salt TTL",
    kind: "number",
    min: 60000,
    suffix: "ms",
    experimental: true,
    description:
      "Only active when ID Rewrite is on. How long the per-session salt mapping is retained in SQLite after the last 502. On expiry, the next 502 starts a fresh salt chain instead of escalating. Default: 3,600,000 ms (1 hour).",
  },
];

const OMO_INTEGRATION_FIELDS: FieldDef[] = [
  {
    key: "experiment_strip_omo_reminder",
    label: "Strip Category+Skill Reminder",
    kind: "toggle",
    experimental: true,
    description:
      "When on, strips oh-my-openagent's Category+Skill Reminder synthetic injection from messages[0] before forwarding upstream. This 486-byte block (injected on turn 2 by the category-skill-reminder hook in oh-my-openagent v4.18.x) invalidates the prompt cache prefix, causing 0% hit rate for 1-2 turns. Enable if you use oh-my-openagent and see cache hit drops on turn 2.",
  },
];

const TTFT_WATCHDOG_FIELDS: FieldDef[] = [
  {
    key: "experiment_ttft_watchdog",
    label: "TTFT Watchdog",
    kind: "toggle",
    experimental: true,
    description:
      "Master toggle for TTFT (time-to-first-token) watchdog. When on, upstream fetches get a first-byte watchdog that aborts stalled connections within ttft_timeout_ms, then retries (same-key, then rewrite-escalation if eligible). When off, only upstream_timeout_ms applies — no retry, no rewrite. Default: off.",
  },
  {
    key: "ttft_timeout_ms",
    label: "TTFT Timeout",
    kind: "number",
    experimental: true,
    description:
      "Watchdog threshold — abort fetch if no first byte arrives within this window, then run retry decision. Default: 60,000 ms (1 min).",
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
      "Cap on total upstream attempts. 1 = original only, 2 = +1 same-key retry, 3 = +1 rewrite-id escalation (when eligible). Default: 2.",
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
      "Suppress retry when gate active count ≥ this percentage of soft limit. Prevents deepening saturated concurrency. Default: 80%.",
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
      "Consecutive retry failures within the failure window that trigger permanent auto-disable of the watchdog (until config reload). Default: 3.",
    required: true,
    min: 1,
  },
  {
    key: "ttft_retry_failure_window_ms",
    label: "Failure Window",
    kind: "number",
    experimental: true,
    description:
      "Sliding window for counting consecutive retry failures toward auto-disable threshold. Default: 300,000 ms (5 min).",
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
      "Delay between retry attempts. Gives upstream a brief recovery window before the next attempt. Default: 30,000 ms (30 s).",
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
      "Periodically pings upstream /v1/models to keep TLS connections warm, avoiding ~750 ms cold-start latency on first request after idle. Default: on.",
    restartRequired: true,
  },
  {
    key: "warmer_interval_ms",
    label: "Interval",
    kind: "number",
    description:
      "Interval between upstream keep-alive pings. Shorter keeps connections warmer but increases background traffic. Default: 20,000 ms (20 s).",
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
      "When on, effective concurrency limit = hard cap. When off (default), effective limit = soft limit. Toggle to switch at runtime — no restart needed.",
  },
  {
    key: "concurrency_hard_cap",
    label: "Hard Cap",
    kind: "number",
    description:
      "Absolute maximum concurrent upstream requests. Non-configurable — derived from /v1/usage. Use 'Use Hard Cap' toggle to select as effective limit.",
    disabled: true,
    umansSourced: true,
  },
  {
    key: "concurrency_soft_limit",
    label: "Soft Limit",
    kind: "number",
    description:
      "Soft concurrency limit. Non-configurable — derived from /v1/usage. Use 'Use Hard Cap' toggle to select as effective limit.",
    disabled: true,
    umansSourced: true,
  },
  {
    key: "concurrency_main_reservation",
    label: "Main Reservation",
    kind: "number",
    description:
      "Slots reserved exclusively for main (non-vision) requests. Prevents vision traffic from starving main requests. Default: 1.",
    required: true,
    min: 1,
  },
  {
    key: "concurrency_vision_reservation",
    label: "Vision Reservation",
    kind: "number",
    description:
      "Slots reserved for vision interception requests. Forced to 0 when vision_strategy is 'never' so no slots are wasted. Default: 1.",
    required: true,
    min: 0,
  },
  {
    key: "release_cooldown_ms",
    label: "Release Cooldown",
    kind: "number",
    description:
      "Delay before releasing a concurrency slot back to the pool after a response completes. Prevents immediate burst re-use. Default: 1,000 ms (1 s).",
    required: true,
    min: 0,
    suffix: "ms",
  },
  {
    key: "rate_limit_requests",
    label: "Rate Limit",
    kind: "number",
    description:
      "Upstream request rate limiting. -1 = unlimited (no limiter), 0 = auto-derive from /v1/usage (requires umans_api_key), >0 = explicit max requests per window. Default: 0 (auto-derive).",
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
      "Upstream failures within the breaker window required to trip the circuit breaker. When open, requests are short-circuited instead of forwarded. Default: 5.",
    required: true,
    min: 1,
  },
  {
    key: "breaker_window_ms",
    label: "Breaker Window",
    kind: "number",
    description:
      "Sliding window for counting upstream failures toward the breaker threshold. Default: 300,000 ms (5 min).",
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "breaker_cooldown_ms",
    label: "Breaker Cooldown",
    kind: "number",
    description:
      "Duration the breaker stays open before allowing a half-open probe. If probe succeeds, breaker closes; if it fails, timer restarts. Default: 60,000 ms (1 min).",
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
      "Maximum time a request can wait in the concurrency queue before timing out and returning an error to the client. Default: 30,000 ms (30 s).",
    required: true,
    min: 100,
    suffix: "ms",
  },
  {
    key: "max_queue_depth",
    label: "Max Queue Depth",
    kind: "number",
    description:
      "Maximum requests waiting in the concurrency queue simultaneously. New requests rejected immediately when full. Default: 256.",
    required: true,
    min: 1,
  },
  {
    key: "queue_max_depth",
    label: "Write Queue Depth",
    kind: "number",
    description:
      "Maximum depth of the write-behind database flush queue (distinct from the concurrency queue). Controls buffered capture writes before backpressure applies. Default: 100.",
    min: 1,
  },
];

const CAPTURE_STORAGE_FIELDS: FieldDef[] = [
  {
    key: "capture_body_max_bytes",
    label: "Capture Body Max Bytes",
    kind: "number",
    description:
      "Maximum size of captured request/response bodies stored in SQLite. Bodies exceeding this are truncated. 0 = no limit (capture full bodies). Default: 10,000,000 (10 MB).",
    min: 0,
  },
  {
    key: "ws_backpressure_limit",
    label: "WS Backpressure Limit",
    kind: "number",
    description:
      "Maximum buffered bytes per WebSocket connection before backpressure applies. Client pauses until it catches up. 0 = Bun default. Default: 1,048,576 (1 MB).",
    min: 0,
    suffix: "bytes",
  },
  {
    key: "ws_close_on_backpressure_limit",
    label: "Close on Backpressure Limit",
    kind: "boolean",
    description:
      "When on, WebSocket connections exceeding the backpressure limit are forcibly closed instead of pausing. Prevents slow clients from accumulating unbounded buffer. Default: on.",
  },
];

const CREDENTIALS_FIELDS: FieldDef[] = [
  {
    key: "umans_api_key",
    label: "Umans API Key",
    kind: "password",
    description:
      "API key for upstream authentication and /v1/usage fetch (concurrency limits, rate-limit source). When empty, proxy runs in fail-safe mode with worst-case limits and priority_low=true. Default: empty.",
    restartRequired: true,
  },
  {
    key: "usage_refresh_ms",
    label: "Usage Refresh",
    kind: "number",
    description:
      "Interval between background /v1/usage fetches. Drives concurrency limit auto-derivation and rate-limit source values. Default: 60,000 ms (1 min).",
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
      "Interval between background /v1/models fetches. Populates vision model dropdown and validates model names. Default: 3,600,000 ms (1 hour).",
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
      "When on, every /v1/usage poll is persisted to SQLite (usage_samples + usage_events + usage_daily tables) and the Usage tab visualizes the history. When off, no history is written. Default: on.",
  },
  {
    key: "usage_raw_retention_days",
    label: "Raw Retention",
    kind: "number",
    description:
      "Days to retain raw usage_samples rows before downsampling into usage_daily aggregate and deleting raw rows. Controls timeline drill-down resolution window. Default: 7.",
    required: true,
    min: 1,
    suffix: "d",
  },
  {
    key: "usage_gap_threshold_minutes",
    label: "Gap Threshold",
    kind: "number",
    description:
      "Minutes between adjacent non-byte-identical samples above which a UTC day is flagged day_completeness=incomplete_window. Tune to your machine's sleep behavior so legitimate idle-coalesce gaps (identical adjacent samples) aren't false-positive flagged. Default: 60.",
    required: true,
    min: 5,
    suffix: "min",
  },
  {
    key: "usage_idle_session_timeout_minutes",
    label: "Idle Session Timeout",
    kind: "number",
    description:
      "Minutes of consecutive open-session intervals with no token movement before the heatmap stops counting them as active. Filters idle-but-open sessions (user walked away, left tab open). Short bursts below this threshold still count as active (reading/thinking). Default: 5.",
    required: true,
    min: 1,
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
        title: "Circuit Breaker",
        description: "Failure detection and circuit breaker thresholds.",
        fields: CIRCUIT_BREAKER_FIELDS,
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
        title: "TTFT Watchdog",
        description:
          "Experimental first-byte watchdog with gated retry. Aborts stalled upstream fetches and retries (same-key, then rewrite-escalation).",
        fields: TTFT_WATCHDOG_FIELDS,
      },
      {
        title: "oh-my-openagent",
        description: "Client-side mitigations for oh-my-openagent harness behaviors.",
        fields: OMO_INTEGRATION_FIELDS,
      },
    ],
  },
  {
    title: "Advanced",
    description: "Queue tuning, vision parameters, and storage internals.",
    sections: [
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
