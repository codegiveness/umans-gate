export type CaptureState = "enqueued" | "streaming" | "done";

export interface CaptureSummary {
  id: number;
  method: string;
  path: string;
  response_status: number | null;
  is_sse: boolean;
  content_type: string | null;
  request_size: number;
  response_size: number;
  duration_ms: number;
  state: CaptureState;
  started_at: number | null;
  finished_at: number | null;
  incoming_protocol: string;
  upstream_protocol: string;
  model: string | null;
  usage_missing: boolean | null;
  ttft_ms: number | null;
  tps: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  total_input_tokens: number | null;
  output_tokens: number | null;
  total_output_tokens: number | null;
  is_vision: boolean;
  status_source: "upstream" | "gate" | null;
  gate_reason: string | null;
}

export interface PerformanceStatsRow {
  model: string;
  provider: "anthropic" | "openai";
  request_count: number;
  streaming_count: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cache_read_tokens: number;
  total_thinking_tokens: number;
  cached_pct: number;
  ttft_mean: number | null;
  ttft_p10: number | null;
  ttft_p50: number | null;
  ttft_p95: number | null;
  ttft_outlier_count: number;
  tps_mean: number | null;
  tps_p10: number | null;
  tps_p50: number | null;
  tps_p95: number | null;
  tps_outlier_count: number;
}

export type VisionSupport = boolean | "via-handoff";

export interface ModelInfo {
  name: string;
  display_name: string;
  description: string;
  base_model: {
    name: string;
    provider?: string;
    family?: string;
    oss_base?: string;
  };
  capabilities: {
    max_completion_tokens: number;
    recommended_max_tokens: number;
    context_window: number;
    supports_vision: VisionSupport;
    supports_tools: boolean;
    reasoning: {
      supported: boolean;
      can_disable: boolean;
      levels: string[];
      default_level: string | null;
    };
  };
  benchmarks: Record<string, unknown>;
  weights: {
    precision: string | undefined;
    hf_url: string | undefined;
  };
  stage?: string;
  lifecycle?: {
    playground_start_date?: string;
  };
}

export interface ModelEntry {
  id: string;
  context_length: number;
  pricing: { input: number; output: number } | null;
  weight: number;
  info: ModelInfo | null;
}

export interface ModelsResponse {
  models: ModelEntry[];
  fetched_at: number;
  ok: boolean;
}

export interface CaptureDetail extends CaptureSummary {
  url: string;
  request_headers: string | null;
  request_body: string | null;
  response_headers: string | null;
  response_body: string | null;
}

export type BreakerState = "closed" | "open" | "half_open";

export interface GateStats {
  active: number;
  queued: number;
  softLimit: number;
  hardCap: number;
  tier: "Code Pro" | "Code Max" | "unknown";
  breaker: BreakerState;
  boxed: boolean;
  boxedReason: string | null;
  boxedUntil: number | null;
  priorityLow: boolean;
  unitsDemoted: boolean;
  demotedUntil: number | null;
  requestsRemaining: number | null;
  requestsInWindow: number;
  requestsLimit: number | null;
  windowSeconds: number | null;
  usageOk: boolean;
  lastUsageFetch: number | null;
  /** Active permits grouped by intention. */
  activeByIntention: Record<string, number>;
  /** Queued waiters grouped by intention. */
  queuedByIntention: Record<string, number>;
  /** Reserved concurrency slots per intention. */
  reservations: Record<string, number>;
  /** Current upstream service mode and optional reset timestamp. */
  serviceMode: ServiceMode;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  windowStartedAt: number | null;
  windowResetsAt: number | null;
  windowRemainingMinutes: number | null;
}

export type WsMessage =
  | { type: "new"; capture: CaptureSummary }
  | { type: "update"; capture: CaptureSummary }
  | { type: "state"; captureId: number; state: CaptureState }
  | { type: "gate"; stats: GateStats }
  | { type: "clear" }
  | { type: "vision-clear" };

export interface ServiceMode {
  current: string;
  resetsAt: number | null;
}

/** Snapshot of /v1/usage response (enriched subset). */
export interface UsageSnapshot {
  ok: boolean;
  fetchedAt: number;
  userId: string | null;
  plan: "Code Pro" | "Code Max" | "unknown";
  planSlug: string | null;
  requestsLimit: number | null;
  requestsHardCap: number | null;
  requestsWindowSeconds: number | null;
  concurrencySoftLimit: number;
  concurrencyHardCap: number;
  requestsInWindow: number;
  weightedRequestsInWindow: number;
  requestsRemaining: number | null;
  weightedRemainingRequests: number | null;
  concurrentSessions: number;
  weightedConcurrentSessions: number;
  tokensIn: number;
  tokensOut: number;
  tokensCached: number;
  windowStartedAt: number | null;
  windowResetsAt: number | null;
  windowRemainingMinutes: number | null;
  priorityLow: boolean;
  boxedUntil: number | null;
  boxedReason: string | null;
  unitsDemoted: boolean;
  demotedUntil: number | null;
  serviceMode: ServiceMode;
}

export interface EconomicsDailyRow {
  date: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  thinking_tokens: number;
  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_creation: number;
  cost_total: number;
  pricing_known: number;
}

export interface EconomicsMonthSummary {
  year: number;
  month: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  thinking_tokens: number;
  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_creation: number;
  cost_total: number;
  has_unpriced: boolean;
  per_model: Array<{
    model: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_total: number;
  }>;
}

export interface ModelPricingRow {
  model_id: string;
  input_per_mtoken: number;
  output_per_mtoken: number;
  cache_read_per_mtoken: number;
  pricing_known: number;
  updated_at: number;
}

export interface EconomicsSummaryResponse {
  summary: EconomicsMonthSummary;
  months: Array<{ year: number; month: number }>;
  pricing: ModelPricingRow[];
}
