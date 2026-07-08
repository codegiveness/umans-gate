// Normalized types for LLM token usage metrics.

/** Normalized per-request usage metrics. All fields nullable. */
export interface UsageMetrics {
  /** Provider: "anthropic" | "openai" */
  provider: "anthropic" | "openai";
  /** Streaming or non-streaming response. */
  streaming: boolean;
  /** Non-cached input tokens. */
  input_tokens: number | null;
  /** Output tokens (cumulative, authoritative, billed). */
  output_tokens: number | null;
  /** Tokens written to cache (Anthropic: cache_creation_input_tokens; OpenAI: n/a). */
  cache_creation_tokens: number | null;
  /** Tokens read from cache (Anthropic: cache_read_input_tokens; OpenAI: prompt_tokens_details.cached_tokens). */
  cache_read_tokens: number | null;
  /** Total input = input + cache_creation + cache_read (Anthropic) or prompt_tokens (OpenAI). */
  total_input_tokens: number | null;
  /** Total output (same as output_tokens for Anthropic; completion_tokens for OpenAI). */
  total_output_tokens: number | null;
  /** Tokens spent on internal reasoning (optional, nullable). */
  thinking_tokens: number | null;
  /** Time-to-first-token in ms. DERIVED from event timing, never an API field. */
  ttft_ms: number | null;
  /** Full request duration in ms. */
  duration_ms: number | null;
  /** Tokens-per-second = output_tokens / ((duration_ms - ttft_ms) / 1000). Null if not computable. */
  tps: number | null;
  /** True if usage was absent (stream aborted, or include_usage not set). */
  usage_missing: boolean;
  /** Model name (set by extractUsage wrapper; not populated by individual extractors). */
  model?: string;
}

/** Anthropic `usage` shape on a non-streaming Message or message_start event. */
export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens_details?: { thinking_tokens?: number } | null;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  } | null;
}

/** A parsed Anthropic SSE event. */
export interface AnthropicSseEvent {
  type: string;
  // message_start.message.usage
  message?: { usage?: AnthropicUsage };
  // message_delta.usage (top-level on event)
  usage?: AnthropicUsage;
  delta?: {
    type?: string;
    stop_reason?: string | null;
    stop_sequence?: string | null;
    text?: string;
    thinking?: string;
    partial_json?: string;
  };
  /** Wall-clock timestamp (ms) when this event was received by the proxy. */
  received_at?: number;
  [key: string]: unknown;
}

/** OpenAI `usage` shape on a non-streaming response or final streaming chunk. */
export interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number; audio_tokens?: number } | null;
  completion_tokens_details?: {
    reasoning_tokens?: number;
    accepted_prediction_tokens?: number;
    rejected_prediction_tokens?: number;
    audio_tokens?: number;
  } | null;
}

/** A parsed OpenAI streaming chunk. */
export interface OpenAIStreamChunk {
  choices: Array<{
    delta?: {
      content?: string;
      /** Reasoning models (GLM, GPT-o1, etc.) emit this before content. */
      reasoning_content?: string;
      /** Tool-calling responses may only carry tool_calls (no content). */
      tool_calls?: Array<{
        index?: number;
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: OpenAIUsage | null;
  /** Wall-clock timestamp (ms) when this chunk was received by the proxy. */
  received_at?: number;
}

/** A chunk of SSE data with its wall-clock receive timestamp. */
export interface TimedChunk {
  text: string;
  time: number;
}

/** A per-request row that includes model + timestamp for dashboard queries. */
export interface ModelRequestRow {
  model: string;
  provider: "anthropic" | "openai";
  captured_at: number; // epoch ms
  metrics: UsageMetrics;
}

/** Percentile summary for a single numeric field. */
export interface PercentileStat {
  count: number;
  min: number;
  p10: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Aggregated per-model performance stats (computed in SQL, not JS). */
export interface PerformanceStatsRow {
  model: string;
  provider: "anthropic" | "openai";
  request_count: number;
  streaming_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  cached_pct: number;
  ttft_p10: number | null;
  ttft_p50: number | null;
  ttft_p95: number | null;
  tps_p10: number | null;
  tps_p50: number | null;
  tps_p95: number | null;
  ttft_mean: number | null;
  tps_mean: number | null;
}

/** Per-model summary row — one per model, computed from the latest N requests. */
export interface ModelSummary {
  model: string;
  provider: "anthropic" | "openai";
  request_count: number;
  streaming_count: number;
  non_streaming_count: number;
  usage_missing_count: number;
  ttft_ms: PercentileStat | null;
  tps: PercentileStat | null;
  duration_ms: PercentileStat | null;
  input_tokens: PercentileStat | null;
  output_tokens: PercentileStat | null;
  cache_creation_tokens: PercentileStat | null;
  cache_read_tokens: PercentileStat | null;
  total_input_tokens: PercentileStat | null;
  total_output_tokens: PercentileStat | null;
}
