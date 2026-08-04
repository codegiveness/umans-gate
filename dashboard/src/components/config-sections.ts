import { VISION_GENERAL_FIELDS, VISION_TUNING_FIELDS } from "@/components/config-vision-fields";
import type { RawConfig, StampModelRuleEntry } from "@/hooks/use-config";

/**
 * Canonical per-model stamp rules (ADR-0020 / request-body-matrix.md).
 * Each toggle in the modelRules renderer adds/removes the matching entry
 * from `stamp_model_rules`. No logic change — pure UI over the existing
 * array field.
 */
export interface CanonicalModelRule {
  pattern: string;
  label: string;
  description: string;
  rule: StampModelRuleEntry;
}

export const CANONICAL_STAMP_MODEL_RULES: CanonicalModelRule[] = [
  {
    pattern: "umans-kimi-k2.7",
    label: "Kimi K2.7",
    description:
      "Keeps thinking on for both routes. Blocks reasoning_effort on OpenAI (it errors out on this model).",
    rule: {
      pattern: "umans-kimi-k2.7",
      anthropic_thinking_shape: { type: "enabled", keep: "all" },
      openai_thinking_shape: { type: "enabled", keep: "all" },
      openai_veto_reasoning_effort: true,
    },
  },
  {
    pattern: "umans-glm-5.2",
    label: "GLM 5.2",
    description: "Keeps thinking on for both routes, with slightly different settings per route.",
    rule: {
      pattern: "umans-glm-5.2",
      anthropic_thinking_shape: { type: "enabled", clear_thinking: false },
      openai_thinking_shape: { type: "enabled", clear_thinking: false },
    },
  },
  {
    pattern: "umans-coder",
    label: "Coder",
    description: "Keeps thinking on for both routes. Blocks reasoning_effort on OpenAI.",
    rule: {
      pattern: "umans-coder",
      anthropic_thinking_shape: { type: "enabled", keep: "all" },
      openai_thinking_shape: { type: "enabled", keep: "all" },
      openai_veto_reasoning_effort: true,
    },
  },
  {
    pattern: "umans-kimi-k3",
    label: "Kimi K3",
    description:
      "Adaptive thinking on Anthropic, thinking on for OpenAI. reasoning_effort allowed.",
    rule: {
      pattern: "umans-kimi-k3",
      anthropic_thinking_shape: { type: "adaptive" },
      openai_thinking_shape: { type: "enabled" },
    },
  },
  {
    pattern: "umans-flash",
    label: "Flash",
    description: "Thinking on for both routes. Adds extra flags to enable and preserve thinking.",
    rule: {
      pattern: "umans-flash",
      anthropic_thinking_shape: { type: "enabled" },
      openai_thinking_shape: { type: "enabled" },
      openai_extra_body: { enable_thinking: true, preserve_thinking: true },
    },
  },
  {
    pattern: "umans-qwen3.6-35b-a3b",
    label: "Qwen 3.6 35B A3B",
    description: "Thinking on for both routes. Adds extra flags to enable and preserve thinking.",
    rule: {
      pattern: "umans-qwen3.6-35b-a3b",
      anthropic_thinking_shape: { type: "enabled" },
      openai_thinking_shape: { type: "enabled" },
      openai_extra_body: { enable_thinking: true, preserve_thinking: true },
    },
  },
];

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
  | "json"
  | "modelRules";

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
  /** input type hint for text inputs: "url", "text", "password", "numeric" */
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
    description: "Which network port the proxy listens on. Default: 1,945.",
    restartRequired: true,
    required: true,
    min: 1,
    max: 65535,
  },
  {
    key: "max_captures",
    label: "Max Captures",
    kind: "number",
    description: "How many requests the proxy remembers before deleting the oldest. Default: 200.",
    restartRequired: true,
    required: true,
    min: 200,
  },
  {
    key: "db_path",
    label: "DB Path",
    kind: "text",
    description: "Where the proxy stores its database on disk. Default: ./umans-gate.db.",
    restartRequired: true,
    required: true,
  },
  {
    key: "idle_timeout",
    label: "Idle Timeout",
    kind: "number",
    description: "Seconds before an idle connection is closed. Max 255 (Bun limit). Default: 255.",
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
      "How the proxy talks to the API. HTTP/1.1 works everywhere. HTTP/2 may help under very heavy load but benchmarks show no difference for typical use. Default: HTTP/1.1.",
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
    description: "Squashes stored requests/responses so the database stays small. Default: on.",
  },
  {
    key: "upstream_timeout_ms",
    label: "Upstream Timeout",
    kind: "number",
    description: "How long to wait for the API to respond before giving up. Default: 30 minutes.",
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "performance_sample_count",
    label: "Performance Sample Count",
    kind: "number",
    description:
      "How many recent requests per model are used to calculate speed stats in the Performance tab. Default: 200.",
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
      "Tweaks Anthropic requests to act more like Claude Code: sets cache TTL to 1 hour, turns on thinking, raises token limits, and a few other optimizations. Leave off if you don't know what this does. Default: off.",
    experimental: true,
  },
  {
    key: "stamp_model_rules",
    label: "Per-Model Rules",
    kind: "modelRules",
    description:
      "Lets you set special thinking behavior for specific models. Flip a switch for each model family you want to override. Works on top of the toggles above. Default: none.",
    experimental: true,
  },
  {
    key: "stamp_reasoning_effort_enabled",
    label: "Reasoning Effort (OpenAI)",
    kind: "toggle",
    description:
      "Tells OpenAI-style requests how hard to think. Removes some fields that conflict with this setting. Leave off if unsure. Default: off.",
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
      "When the API returns an overload error (502/529), the proxy changes the session and tool IDs and tries again. Only works with the opencode harness. Helps avoid stuck sessions. Default: on.",
  },
  {
    key: "experiment_rewrite_ttl_ms",
    label: "Salt TTL",
    kind: "number",
    min: 60000,
    suffix: "ms",
    experimental: true,
    description:
      "Only works when ID Rewrite is on. How long the proxy remembers the ID changes after the last error. After that, it starts fresh. Default: 1 hour.",
  },
];

const OMO_INTEGRATION_FIELDS: FieldDef[] = [
  {
    key: "experiment_strip_omo_reminder",
    label: "Strip Category+Skill Reminder",
    kind: "toggle",
    experimental: true,
    description:
      "Removes a small block of text that oh-my-openagent adds to your messages. This text breaks caching and wastes money. Default: on; turn off if you don't use oh-my-openagent.",
  },
];

const TTFT_WATCHDOG_FIELDS: FieldDef[] = [
  {
    key: "experiment_ttft_watchdog",
    label: "TTFT Watchdog",
    kind: "toggle",
    experimental: true,
    description:
      "Watches for requests where the API never sends the first byte. If stuck, it cancels and retries. Turn off to use only the basic timeout. Default: on.",
  },
  {
    key: "ttft_timeout_ms",
    label: "TTFT Timeout",
    kind: "number",
    experimental: true,
    description:
      "How long to wait for the first byte from the API before assuming it's stuck. Default: 1 minute.",
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
      "Total tries per request. 1 = no retry, 2 = one normal retry, 3 = one retry plus an ID-rewrite retry. Default: 3.",
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
      "Skip retrying when the proxy is this full. Stops piling more work onto an already busy system. Default: 80%.",
    required: true,
    min: 1,
    max: 100,
    suffix: "%",
  },
  {
    key: "ttft_retry_cooldown_ms",
    label: "Retry Cooldown",
    kind: "number",
    experimental: true,
    description: "Pause between retries so the API has a moment to recover. Default: 5 seconds.",
    required: true,
    min: 0,
    suffix: "ms",
  },
  {
    key: "ttft_watchdog_multiplier",
    label: "Watchdog Multiplier",
    kind: "number",
    experimental: true,
    description:
      "Sets the timeout based on typical response time. Higher = more patient with slow APIs. Default: 5.",
    required: true,
    min: 1,
  },
  {
    key: "ttft_watchdog_hard_cap_ms",
    label: "Watchdog Hard Cap",
    kind: "number",
    experimental: true,
    description:
      "The longest the watchdog will ever wait, even if the calculated timeout is higher. Default: 5 minutes.",
    required: true,
    min: 1000,
    suffix: "ms",
  },
];

const WARMER_FIELDS: FieldDef[] = [
  {
    key: "warmer_enabled",
    label: "Enabled",
    kind: "boolean",
    description:
      "Pings the API in the background to keep the connection warm. Stops the first real request from being slow. Default: on.",
    restartRequired: true,
  },
  {
    key: "warmer_interval_ms",
    label: "Interval",
    kind: "number",
    description:
      "How often to ping the API. Shorter = warmer but more background chatter. Default: 20 seconds.",
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
      "Pick which limit to use. On = use the hard cap (max allowed). Off = use the soft limit (safer). Switch anytime, no restart needed.",
  },
  {
    key: "concurrency_hard_cap",
    label: "Hard Cap",
    kind: "number",
    description:
      "The absolute max number of requests at once. Pulled from your API plan. Use the toggle above to pick this as your limit.",
    disabled: true,
    umansSourced: true,
  },
  {
    key: "concurrency_soft_limit",
    label: "Soft Limit",
    kind: "number",
    description:
      "A gentler limit for normal use. Pulled from your API plan. Use the toggle above to pick this as your limit.",
    disabled: true,
    umansSourced: true,
  },
  {
    key: "concurrency_main_reservation",
    label: "Main Reservation",
    kind: "number",
    description:
      "Slots kept just for normal requests so image tasks can't hog everything. Default: 1.",
    required: true,
    min: 1,
  },
  {
    key: "concurrency_vision_reservation",
    label: "Vision Reservation",
    kind: "number",
    description: "Slots kept just for image tasks. Set to 0 when vision is off. Default: 1.",
    required: true,
    min: 0,
  },
  {
    key: "release_cooldown_ms",
    label: "Release Cooldown",
    kind: "number",
    description:
      "Pause before reusing a slot. Stops bursts from overwhelming the API. Default: 1 second.",
    required: true,
    min: 0,
    suffix: "ms",
  },
  {
    key: "rate_limit_requests",
    label: "Rate Limit",
    kind: "number",
    description:
      "How many requests per window the proxy allows. -1 = no limit, 0 = guess from your API plan, any other number = that exact limit. Default: 0 (auto).",
    min: -1,
    umansSourced: true,
    refreshSource: true,
  },
  {
    key: "never_limit_requests",
    label: "Never Limit Requests",
    kind: "toggle",
    description:
      "On (default): do not enforce any local request cap — let upstream handle limits. Off: enforce the request cap from your API plan. Switch anytime, no restart needed.",
  },
  {
    key: "request_use_hard_cap",
    label: "Use Request Hard Cap",
    kind: "toggle",
    description:
      "Pick which request cap to enforce. On = use the request hard cap (max requests per window). Off = use the soft limit (safer). Switch anytime, no restart needed.",
  },
  {
    key: "request_hard_cap",
    label: "Request Hard Cap",
    kind: "number",
    description:
      "The absolute max number of requests per window. Pulled from your API plan. Use the toggle above to pick this as your cap.",
    disabled: true,
    umansSourced: true,
  },
  {
    key: "request_soft_limit",
    label: "Request Soft Limit",
    kind: "number",
    description:
      "A gentler request cap for normal use. Pulled from your API plan. Use the toggle above to pick this as your cap.",
    disabled: true,
    umansSourced: true,
  },
];

const CIRCUIT_BREAKER_FIELDS: FieldDef[] = [
  {
    key: "breaker_threshold",
    label: "Breaker Threshold",
    kind: "number",
    description:
      "How many overload (429) errors trigger the safety shutoff. When hit, the proxy stops sending requests for a bit. Default: 5.",
    required: true,
    min: 1,
  },
  {
    key: "breaker_window_ms",
    label: "Breaker Window",
    kind: "number",
    description:
      "The time window for counting overload errors. Errors older than this don't count. Default: 5 minutes.",
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "breaker_cooldown_ms",
    label: "Breaker Cooldown",
    kind: "number",
    description:
      "How long the proxy stops sending requests after the safety shutoff. Then it tries one request to see if the API is back. Default: 1 minute.",
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
      "How long a waiting request can sit before it gives up and errors out. Default: 3 minutes.",
    required: true,
    min: 100,
    suffix: "ms",
  },
  {
    key: "max_queue_depth",
    label: "Max Queue Depth",
    kind: "number",
    description:
      "How many requests can wait at once. Extra requests are rejected right away. Default: 256.",
    required: true,
    min: 1,
  },
  {
    key: "queue_max_depth",
    label: "Write Queue Depth",
    kind: "number",
    description:
      "How many saves the proxy batches up before writing to disk. Separate from the request queue above. Default: 100.",
    restartRequired: true,
    min: 1,
  },
];

const CAPTURE_STORAGE_FIELDS: FieldDef[] = [
  {
    key: "capture_body_max_bytes",
    label: "Capture Body Max Bytes",
    kind: "number",
    description:
      "Biggest request/response the proxy will store fully. Bigger ones get cut off. 0 = store everything. Default: 10 MB.",
    min: 0,
  },
  {
    key: "ws_backpressure_limit",
    label: "WS Backpressure Limit",
    kind: "number",
    description:
      "Most data the proxy buffers per dashboard connection. If the viewer falls behind, it pauses. 0 = Bun's default. Default: 1 MB.",
    restartRequired: true,
    min: 0,
    suffix: "bytes",
  },
  {
    key: "ws_close_on_backpressure_limit",
    label: "Close on Backpressure Limit",
    kind: "boolean",
    description:
      "When on, slow dashboard viewers get disconnected instead of paused. Stops memory from growing unbounded. Default: on.",
    restartRequired: true,
  },
];

const CREDENTIALS_FIELDS: FieldDef[] = [
  {
    key: "umans_api_key",
    label: "Umans API Key",
    kind: "password",
    description:
      "Your API key. Without it, the proxy runs in safe mode with weaker limits. Add it to unlock usage stats, smart limits, and image handling. Default: empty.",
    restartRequired: true,
  },
  {
    key: "usage_refresh_ms",
    label: "Usage Refresh",
    kind: "number",
    description:
      "How often the proxy checks your API usage. Drives smart limits and rate limiting. Default: 1 minute.",
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
      "How often the proxy refreshes the list of available models. Fills the model dropdown. Default: 1 hour.",
    restartRequired: true,
    required: true,
    min: 1000,
    suffix: "ms",
  },
];

const INCIDENT_FIELDS: FieldDef[] = [
  {
    key: "incident_retention_days",
    label: "Incident Retention",
    kind: "number",
    description:
      "How many days to keep records of failed requests. Older ones are deleted on startup. Default: 30.",
    min: 1,
    suffix: "d",
  },
];

const USAGE_HISTORY_FIELDS: FieldDef[] = [
  {
    key: "usage_history_enabled",
    label: "Usage History",
    kind: "toggle",
    description:
      "Saves your usage numbers over time so the Usage tab can show charts. Turn off to save space. Default: on.",
  },
  {
    key: "usage_raw_retention_days",
    label: "Raw Retention",
    kind: "number",
    description:
      "Days to keep detailed usage data before squishing it into daily summaries. Longer = more detail, more space. Default: 7.",
    required: true,
    min: 1,
    suffix: "d",
  },
  {
    key: "usage_gap_threshold_minutes",
    label: "Gap Threshold",
    kind: "number",
    description:
      "If usage data has a gap longer than this, that day is marked incomplete. Tune to match when your machine sleeps. Default: 60.",
    required: true,
    min: 5,
    suffix: "min",
  },
  {
    key: "usage_idle_session_timeout_minutes",
    label: "Idle Session Timeout",
    kind: "number",
    description:
      "If a session has no activity for this long, the heatmap stops counting it as active. Filters out sessions left open but unused. Default: 5.",
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
    description: "The settings you'll touch most often.",
    sections: [
      {
        title: "Server",
        description: "Basic network and storage settings.",
        fields: SERVER_FIELDS,
      },
      {
        title: "Credentials",
        description: "Your API key and how often the proxy checks usage and models.",
        fields: CREDENTIALS_FIELDS,
      },
      {
        title: "Vision",
        description: "How the proxy handles images in requests.",
        fields: VISION_GENERAL_FIELDS,
      },
      {
        title: "Warmer",
        description: "Keeps the connection to the API warm so requests aren't slow.",
        fields: WARMER_FIELDS,
      },
      {
        title: "Concurrency & Gate",
        description: "Controls how many requests happen at once and rate limits.",
        fields: CONCURRENCY_GATE_FIELDS,
      },
      {
        title: "Circuit Breaker",
        description: "Stops sending requests if the API keeps returning overload errors.",
        fields: CIRCUIT_BREAKER_FIELDS,
      },
      {
        title: "Usage History",
        description: "Saves usage data over time for the Usage tab charts.",
        fields: USAGE_HISTORY_FIELDS,
      },
    ],
  },
  {
    title: "Experimental",
    description: "New features that might change behavior. Use with care.",
    sections: [
      {
        title: "Request Stamp",
        description: "Tweaks requests before sending them to the API.",
        fields: STAMP_FIELDS,
      },
      {
        title: "ID Rewrite",
        description: "Retries with new IDs when the API is overloaded.",
        fields: ID_REWRITE_FIELDS,
      },
      {
        title: "TTFT Watchdog",
        description: "Catches requests where the API never responds and retries them.",
        fields: TTFT_WATCHDOG_FIELDS,
      },
      {
        title: "oh-my-openagent",
        description: "Fixes for oh-my-openagent users.",
        fields: OMO_INTEGRATION_FIELDS,
      },
    ],
  },
  {
    title: "Advanced",
    description: "Fine-tuning for queues, vision, and storage.",
    sections: [
      {
        title: "Queue",
        description: "How waiting requests are handled.",
        fields: QUEUE_FIELDS,
      },
      {
        title: "Vision Tuning",
        description: "Detailed settings for image handling.",
        fields: VISION_TUNING_FIELDS,
      },
      {
        title: "Capture & Storage",
        description: "Limits on what gets stored and dashboard buffering.",
        fields: CAPTURE_STORAGE_FIELDS,
      },
      {
        title: "Incidents",
        description: "How long to keep records of failed requests.",
        fields: INCIDENT_FIELDS,
      },
    ],
  },
];

/** Flat list of all sections across all groups (for validation and lookups). */
export const SECTIONS: SectionDef[] = GROUPS.flatMap((g) => g.sections);
