export type CaptureState = "enqueued" | "streaming" | "cooling_down" | "done";

// Keep in sync with src/incidents.ts
export type ResponsibleParty = "upstream" | "proxy" | "client";

// Keep in sync with src/incidents.ts
export type IncidentType =
  | "upstream_error"
  | "ttft_timeout"
  | "id_rewrite"
  | "rate_limited"
  | "gate_rejected"
  | "client_aborted";

export interface IncidentRow {
  id: number;
  capture_id: number;
  responsible_party: ResponsibleParty;
  incident_type: IncidentType;
  upstream_status: number | null;
  served_status: number;
  reason: string | null;
  retry_attempt: number | null;
  ttft_exceeded: number | null;
  created_at: number;
  capture_model: string | null;
  capture_path: string | null;
}

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
  retry_attempt: number | null;
  ttft_exceeded: number | null;
  /** Transient (WS-only) — retry attempt ordinal during in-flight retry. Cleared on refresh. */
  retryAttempt?: number;
  /** Transient (WS-only) — epoch ms when cooldown ends. Cleared on refresh. */
  cooldownEndsAt?: number;
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
  requests_with_thinking: number;
  cached_pct: number;
  ttft_mean: number | null;
  ttft_max: number | null;
  ttft_p10: number | null;
  ttft_p50: number | null;
  ttft_p95: number | null;
  ttft_outlier_count: number;
  tps_mean: number | null;
  tps_min: number | null;
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
  effectiveLimit: number;
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
  /** TTFT watchdog auto-disable state. */
  watchdog_disabled: boolean;
  watchdog_consecutive_failures: number;
  watchdog_failure_window_started_at: number | null;
  priorityBudgetSummary: PriorityBudgetSummary | null;
}

export type WsMessage =
  | { type: "new"; capture: CaptureSummary }
  | { type: "update"; capture: CaptureSummary }
  | {
      type: "state";
      captureId: number;
      state: CaptureState;
      retryAttempt?: number;
      cooldownEndsAt?: number;
    }
  | { type: "gate"; stats: GateStats }
  | { type: "clear" }
  | { type: "vision-clear" }
  | { type: "prune"; ids: number[] }
  // Usage-history dirty notifications (ticket 07). Dashboard re-fetches the
  // relevant view via HTTP on receipt — the WS message carries no ambient
  // payload, only enough to know which view to refresh.
  | { type: "usage-sample"; dayUtc: string; fetchedAt: number }
  | {
      type: "usage-event";
      dayUtc: string;
      tupleKind: "priority" | "service_mode";
      transition: "onset" | "resolved" | "morph";
      fetchedAt: number;
    }
  | { type: "version"; version: import("./hooks/use-version").VersionInfo };

export interface ServiceMode {
  current: string;
  resetsAt: number | null;
}

export interface PriorityBudgetEntry {
  category: string;
  label: string;
  models: string[];
  usedPct: number;
  overBudgetToday: boolean;
  mode: string;
  resetsAt: number | null;
}

export interface PriorityBudgetSummary {
  category: string;
  label: string;
  models: string[];
  usedPct: number;
  overBudgetToday: boolean;
  mode: string;
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
  priorityBudget: PriorityBudgetEntry[];
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

/** One coalesced /v1/usage sample row (ticket 01: raw samples storage). */
export interface UsageSampleRow {
  id: number;
  fetched_at: number;
  ok: number;
  user_id: string | null;
  plan: string;
  plan_slug: string | null;
  requests_limit: number | null;
  requests_hard_cap: number | null;
  requests_window_seconds: number | null;
  concurrency_soft_limit: number;
  concurrency_hard_cap: number;
  requests_in_window: number;
  weighted_requests_in_window: number;
  requests_remaining: number | null;
  weighted_remaining_requests: number | null;
  concurrent_sessions: number;
  weighted_concurrent_sessions: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  window_started_at: number | null;
  window_resets_at: number | null;
  window_remaining_minutes: number | null;
  priority_low: number;
  boxed_until: number | null;
  boxed_reason: string | null;
  units_demoted: number;
  demoted_until: number | null;
  service_mode_current: string;
  service_mode_resets_at: number | null;
}

/** One composite tuple transition event row (ticket 02: events storage).
 *  Carries full ambient context at the moment of transition (decision 05). */
export interface UsageEventRow {
  id: number;
  onset_at: number;
  transition: "onset" | "resolved" | "morph";
  tuple_kind: "priority" | "service_mode";
  previous_event_id: number | null;
  fetched_at: number;
  ok: number;
  user_id: string | null;
  plan: string;
  plan_slug: string | null;
  requests_limit: number | null;
  requests_hard_cap: number | null;
  requests_window_seconds: number | null;
  concurrency_soft_limit: number;
  concurrency_hard_cap: number;
  requests_in_window: number;
  weighted_requests_in_window: number;
  requests_remaining: number | null;
  weighted_remaining_requests: number | null;
  concurrent_sessions: number;
  weighted_concurrent_sessions: number;
  tokens_in: number;
  tokens_out: number;
  tokens_cached: number;
  cache_hit_rate: number | null;
  window_started_at: number | null;
  window_resets_at: number | null;
  window_remaining_minutes: number | null;
  priority_low: number;
  boxed_until: number | null;
  boxed_reason: string | null;
  units_demoted: number;
  demoted_until: number | null;
  service_mode_current: string;
  service_mode_resets_at: number | null;
}

/** One row per UTC day (ticket 03: daily aggregate). Per decision 08:
 *  two-snapshot model (trigger-moment + day-total) + two-dimension activity. */
export interface UsageDailyRow {
  day_utc: string;
  day_completeness:
    | "full"
    | "partial_start"
    | "partial_end"
    | "partial_both"
    | "missing"
    | "incomplete_window";
  first_activity_utc: number | null;
  last_activity_utc: number | null;
  accumulated_active_minutes: number | null;
  utc_clock_span_minutes: number | null;
  first_activity_utc_hour: number | null;
  last_activity_utc_hour: number | null;
  active_minutes_by_utc_hour: string | null;
  tokens_in_total: number | null;
  tokens_out_total: number | null;
  tokens_cached_total: number | null;
  requests_in_window_peak: number | null;
  requests_in_window_avg: number | null;
  cache_hit_rate_avg: number | null;
  concurrent_sessions_peak: number | null;
  concurrent_sessions_avg: number | null;
  weighted_concurrent_sessions_peak: number | null;
  weighted_concurrent_sessions_avg: number | null;
  at_first_priority_event_concurrent_sessions: number | null;
  at_first_priority_event_weighted_concurrent_sessions: number | null;
  at_first_priority_event_requests_in_window: number | null;
  at_first_priority_event_weighted_requests_in_window: number | null;
  at_first_priority_event_requests_remaining: number | null;
  at_first_priority_event_requests_limit: number | null;
  at_first_priority_event_tokens_in: number | null;
  at_first_priority_event_tokens_out: number | null;
  at_first_priority_event_tokens_cached: number | null;
  at_first_priority_event_cache_hit_rate: number | null;
  at_first_service_mode_event_concurrent_sessions: number | null;
  at_first_service_mode_event_weighted_concurrent_sessions: number | null;
  at_first_service_mode_event_requests_in_window: number | null;
  at_first_service_mode_event_weighted_requests_in_window: number | null;
  at_first_service_mode_event_requests_remaining: number | null;
  at_first_service_mode_event_requests_limit: number | null;
  at_first_service_mode_event_tokens_in: number | null;
  at_first_service_mode_event_tokens_out: number | null;
  at_first_service_mode_event_tokens_cached: number | null;
  at_first_service_mode_event_cache_hit_rate: number | null;
  priority_low_minutes: number | null;
  boxed_minutes: number | null;
  units_demoted_minutes: number | null;
  service_mode_non_normal_minutes: number | null;
  priority_events_count: number | null;
  service_mode_events_count: number | null;
  priority_ban_total_duration_ms: number | null;
  service_mode_ban_total_duration_ms: number | null;
  concurrency_hard_cap: number | null;
  requests_limit: number | null;
  requests_hard_cap: number | null;
  downsampled_at: number;
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
