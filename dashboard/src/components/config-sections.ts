import { VISION_FIELDS } from "@/components/config-vision-fields";
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
}

const SERVER_FIELDS: FieldDef[] = [
  {
    key: "port",
    label: "Port",
    kind: "number",
    description: "Port the proxy listens on (1–65535).",
    restartRequired: true,
    required: true,
    min: 1,
    max: 65535,
  },
  {
    key: "host",
    label: "Host",
    kind: "text",
    description: "Bind address.",
    restartRequired: true,
    required: true,
  },
  {
    key: "max_captures",
    label: "Max Captures",
    kind: "number",
    description: "Ring buffer size for stored captures. Older captures are evicted.",
    restartRequired: true,
    required: true,
    min: 1,
  },
  {
    key: "db_path",
    label: "DB Path",
    kind: "text",
    description: "SQLite database file path.",
    restartRequired: true,
    required: true,
  },
  {
    key: "idle_timeout",
    label: "Idle Timeout",
    kind: "number",
    description: "Bun.serve idleTimeout — HTTP connection idle timeout in seconds (1–255).",
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
    options: [
      { value: "http1.1", label: "HTTP/1.1" },
      { value: "http2", label: "HTTP/2" },
    ],
    restartRequired: true,
    required: true,
  },
];

const STAMP_FIELDS: FieldDef[] = [
  {
    key: "stamp_cache_ttl_enabled",
    label: "Cache TTL",
    kind: "toggle",
    description: "Stamp TTL=1h onto Anthropic ephemeral cache_control blocks. Off by default.",
    experimental: true,
  },
  {
    key: "stamp_top_k_enabled",
    label: "Top-K",
    kind: "toggle",
    description: "Only stamp the top-20 ephemeral blocks per request. Off by default.",
    experimental: true,
  },
  {
    key: "stamp_max_tokens_enabled",
    label: "Max Tokens",
    kind: "toggle",
    description: "Stamp max_tokens=32000 onto Anthropic requests for all models. Off by default.",
    experimental: true,
  },
  {
    key: "stamp_thinking_enabled",
    label: "Thinking",
    kind: "toggle",
    description:
      "Stamp thinking={type:'adaptive'} onto Anthropic requests for umans-coder, umans-flash, umans-kimi*, and umans-qwen* models. Off by default.",
    experimental: true,
  },
  {
    key: "stamp_output_config_enabled",
    label: "Output Config",
    kind: "toggle",
    description:
      "Stamp output_config={effort:'high'} onto Anthropic requests for all models; umans-glm* models get effort='max'. Off by default.",
    experimental: true,
  },
  {
    key: "stamp_reasoning_effort_enabled",
    label: "Reasoning Effort (OpenAI)",
    kind: "toggle",
    description:
      "On OpenAI-compatible routes, remove max_tokens/thinking and stamp reasoning_effort='high' (reasoning_effort='max' for umans-glm* models). Off by default.",
    experimental: true,
  },
];

const WARMER_FIELDS: FieldDef[] = [
  {
    key: "warmer_enabled",
    label: "Enabled",
    kind: "boolean",
    description: "Periodically ping upstream to keep connections warm.",
    restartRequired: true,
  },
  {
    key: "warmer_interval_ms",
    label: "Interval",
    kind: "number",
    description: "Time between keep-alive pings.",
    restartRequired: true,
    required: true,
    min: 1000,
    suffix: "ms",
  },
];

const CONCURRENCY_FIELDS: FieldDef[] = [
  {
    key: "concurrency_hard_cap",
    label: "Hard Cap",
    kind: "number",
    description: "Max concurrent upstream requests. Never exceeded. Sourced from /v1/usage.",
    required: true,
    min: 1,
  },
  {
    key: "concurrency_soft_limit",
    label: "Soft Limit",
    kind: "number",
    description: "Soft concurrency limit (read-only from /v1/usage).",
    disabled: true,
    min: 1,
  },
  {
    key: "concurrency_main_reservation",
    label: "Main Reservation",
    kind: "number",
    description: "Slots reserved for main (non-vision) requests. Min 1, max hard_cap − 1.",
    required: true,
    min: 1,
  },
  {
    key: "concurrency_vision_reservation",
    label: "Vision Reservation",
    kind: "number",
    description: "Slots reserved for vision handoff requests. Min 1, max hard_cap − 1.",
    required: true,
    min: 1,
  },
  {
    key: "concurrency_weights",
    label: "Concurrency Weights",
    kind: "json",
    description:
      'Per-model concurrency weights as a JSON object (e.g. {"umans-glm-5.2": 2}). Every value must be a positive number.',
  },
  {
    key: "release_cooldown_ms",
    label: "Release Cooldown",
    kind: "number",
    description: "Delay before releasing a concurrency slot after a response completes.",
    required: true,
    min: 0,
    suffix: "ms",
  },
  {
    key: "breaker_threshold",
    label: "Breaker Threshold",
    kind: "number",
    description:
      "Number of upstream failures within the breaker window that triggers opening the circuit breaker.",
    required: true,
    min: 1,
  },
  {
    key: "breaker_window_ms",
    label: "Breaker Window",
    kind: "number",
    description: "Sliding window length for counting failures toward the breaker threshold.",
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "breaker_cooldown_ms",
    label: "Breaker Cooldown",
    kind: "number",
    description: "Duration the circuit breaker stays open before allowing a half-open probe.",
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "queue_timeout_ms",
    label: "Queue Timeout",
    kind: "number",
    description: "Maximum time a request may wait in the queue before timing out with an error.",
    required: true,
    min: 100,
    suffix: "ms",
  },
  {
    key: "max_queue_depth",
    label: "Max Queue Depth",
    kind: "number",
    description:
      "Maximum number of queued requests. New requests beyond this are immediately rejected.",
    required: true,
    min: 1,
  },
];

const RATE_LIMIT_FIELDS: FieldDef[] = [
  {
    key: "rate_limit_requests",
    label: "Requests",
    kind: "number",
    description:
      "Max requests in the rolling window. 0 = disabled. Window length is derived from /v1/usage. Validated against upstream hard cap at save time.",
    min: 0,
  },
];

const USAGE_FIELDS: FieldDef[] = [
  {
    key: "umans_api_key",
    label: "Umans API Key",
    kind: "password",
    description: "API key used to fetch upstream usage. Leave empty to disable.",
    restartRequired: true,
  },
  {
    key: "usage_refresh_ms",
    label: "Usage Refresh",
    kind: "number",
    description: "Interval between usage stats fetches.",
    restartRequired: true,
    required: true,
    min: 1000,
    suffix: "ms",
  },
  {
    key: "usage_stats_latest_n",
    label: "Stats Latest N",
    kind: "number",
    description: "Number of recent captures used for stats aggregation.",
    required: true,
    min: 1,
  },
];

const MODELS_FIELDS: FieldDef[] = [
  {
    key: "models_refresh_ms",
    label: "Models Refresh",
    kind: "number",
    description:
      "Interval between /v1/models fetches. Models with output pricing < 2 get weight 0.5; others default to 1.",
    restartRequired: true,
    required: true,
    min: 1000,
    suffix: "ms",
  },
];

export interface SectionDef {
  title: string;
  description: string;
  fields: FieldDef[];
}

export const SECTIONS: SectionDef[] = [
  { title: "Server", description: "Network binding and storage.", fields: SERVER_FIELDS },
  {
    title: "Request Stamp",
    description:
      "Anthropic request body stamping (cache_control TTL, top_k, max_tokens, thinking, output_config).",
    fields: STAMP_FIELDS,
  },
  { title: "Warmer", description: "Keep-alive pings.", fields: WARMER_FIELDS },
  { title: "Concurrency", description: "Gate, breaker, and queue.", fields: CONCURRENCY_FIELDS },
  { title: "Rate Limit", description: "Rolling-window limiter.", fields: RATE_LIMIT_FIELDS },
  { title: "Usage", description: "Upstream usage stats.", fields: USAGE_FIELDS },
  { title: "Models", description: "Model list + weight derivation.", fields: MODELS_FIELDS },
  { title: "Vision", description: "Vision interception pipeline.", fields: VISION_FIELDS },
];
