// Shared types for the umans-gate capture proxy.

import type { VersionInfo } from "./updater.js";
import type { UsageMetrics } from "./usage-extract.js";

/** HTTP protocol used for the upstream connection. */
export type UpstreamProtocol = "http2" | "http1.1";

/** HTTP protocol for incoming connections (always http1.1 without TLS). */
export type IncomingProtocol = "http1.1";

/** Capture state lifecycle. `cooling_down` is a transient WS-only state —
 *  the DB never persists it (the DB state column stays `streaming` during
 *  cooldown). It is broadcast so the dashboard can show a `cooldown` badge. */
export type CaptureState = "enqueued" | "streaming" | "cooling_down" | "done" | "failed";

/** A full capture row from the database. */
export interface CaptureRow {
  id: number;
  method: string;
  path: string;
  url: string;
  request_headers: string | null;
  request_body: string | null;
  request_size: number;
  response_status: number | null;
  response_headers: string | null;
  response_body: string | null;
  response_size: number;
  content_type: string | null;
  is_sse: number;
  duration_ms: number;
  state: CaptureState;
  started_at: number | null;
  finished_at: number | null;
  incoming_protocol: string | null;
  upstream_protocol: string | null;
  provider: string | null;
  model: string | null;
  streaming: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_creation_tokens: number | null;
  cache_read_tokens: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  thinking_tokens: number | null;
  ttft_ms: number | null;
  tps: number | null;
  usage_missing: number | null;
  metrics_extracted_at: number | null;
  is_vision: number;
  parent_capture_id: number | null;
  status_source: string | null;
  gate_reason: string | null;
  retry_attempt: number | null;
  ttft_exceeded: number | null;
  upstream_ttft_p50_ms: number | null;
  upstream_tps_p50: number | null;
}

/** Summary of a capture (no body data) — used in list view and WS broadcasts. */
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
  /** Time-to-first-token in ms (null if not computed or non-streaming). */
  ttft_ms: number | null;
  /** Tokens-per-second (null if not computable). */
  tps: number | null;
  /** Tokens written to cache (Anthropic cache_creation_input_tokens). */
  cache_creation_tokens: number | null;
  /** Tokens read from cache (cache hits). */
  cache_read_tokens: number | null;
  /** Total input tokens (input + cache_creation + cache_read). */
  total_input_tokens: number | null;
  /** Output tokens (non-cached, billed). */
  output_tokens: number | null;
  /** Total output tokens (same as output_tokens for most providers). */
  total_output_tokens: number | null;
  /** True if this row is a vision-model API call (merged into captures). */
  is_vision: boolean;
  /** "upstream" = status from upstream API; "gate" = proxy-generated; null = not yet recorded. */
  status_source: "upstream" | "gate" | null;
  /** Human-readable explanation when the proxy generated the HTTP status. */
  gate_reason: string | null;
  /** Final retry attempt count (0 = no retry, 1 = same-key, 2 = rewrite escalation). */
  retry_attempt: number | null;
  /** 1 if the TTFT watchdog fired on any attempt, 0 otherwise. Null if not applicable. */
  ttft_exceeded: number | null;
  /** Transient (in-memory only, not persisted) — retry attempt ordinal during in-flight cooldown. */
  retryAttempt?: number;
  /** Transient (in-memory only, not persisted) — epoch ms when cooldown ends. */
  cooldownEndsAt?: number;
  /** Upstream p50 TTFT in ms (dynamic-threshold watchdog; null until populated). */
  upstream_ttft_p50_ms?: number | null;
  /** Upstream p50 TPS (dynamic-threshold watchdog; null until populated). */
  upstream_tps_p50?: number | null;
}

/** Request metadata captured at proxy time. */
export interface RequestMeta {
  method: string;
  path: string;
  request_size: number;
  started_at: number;
}

/** Response metadata queued for write-behind. */
export interface ResponseMeta {
  $status: number;
  $rh: string;
  $rb: string;
  $rs: number;
  $ct: string;
  $sse: number;
  $dur: number;
  $fin: number;
  $status_source: "upstream" | "gate" | null;
  $gate_reason: string | null;
  $usage?: UsageMetrics | null;
  $model?: string | null;
  $retry_attempt?: number | null;
  $ttft_exceeded?: number | null;
  $upstream_ttft_p50_ms?: number | null;
  $upstream_tps_p50?: number | null;
}

/** WebSocket message types broadcast to connected inspector clients. */
export type WsMessage =
  | { type: "new"; capture: CaptureSummary }
  | { type: "update"; capture: CaptureSummary }
  | {
      type: "state";
      captureId: number;
      state: CaptureState;
      retryAttempt?: number;
      cooldownEndsAt?: number;
      threshold?: number | null;
      responseStatus?: number | null;
      statusSource?: "upstream" | "gate" | null;
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
  | { type: "version"; version: VersionInfo };

/** Configuration object resolved from environment variables. */
export interface ProxyConfig {
  port: number;
  host: string;
  target: string;
  maxCaptures: number;
  dbPath: string;
  viewerPrefix: string;
  flushIntervalMs: number;
  flushBatch: number;
  idleTimeout: number;
  upstreamProtocol: UpstreamProtocol;
  incomingProtocol: IncomingProtocol;
  /** Apply the Claude Code stamp bundle on Anthropic requests (TTL, top_k, max_tokens, thinking, output_config, context_management). */
  stampClaudeCode: boolean;
  /** When true and stampClaudeCode is on, stamps GLM 5.2 Preserved Thinking (clear_thinking: false) for models matching "5.2". */
  stampGlm52Thinking: boolean;
  /** When true and stampClaudeCode is on, stamps Kimi K2.7-Code Preserved Thinking (keep: "all") for models matching "k2.7-code". */
  stampKimiK27CodeThinking: boolean;
  /** Value to inject as `reasoning_effort` on OpenAI request bodies. Null = disabled. */
  stampReasoningEffort: "high" | "max" | null;
  openaiPath: string;
  /** Upstream connection warmer — pings upstream to prevent TLS handshake overhead on first request. */
  warmerEnabled: boolean;
  /** Warmer ping interval in milliseconds. */
  warmerIntervalMs: number;
  /** Path appended to `target` for warmer pings (no auth required). */
  warmerPath: string;
  /** Umans API key for /v1/usage calls (required for tier-aware limits). Null = fail-safe mode. */
  umansApiKey: string | null;
  /** Optional bearer token for dashboard API authentication. Null = no auth required. */
  dashboardToken: string | null;
  /** Polling interval for /v1/usage reconciliation, in ms. */
  usageRefreshMs: number;
  /** When true, persists coalesced /v1/usage snapshots to usage_samples for the Usage dashboard tab. Hot-reloadable. */
  usageHistoryEnabled: boolean;
  /** Raw usage_samples retention in days. Hot-reloadable. */
  usageRawRetentionDays: number;
  /** Gap threshold (minutes) for marking a UTC day as incomplete_window. Hot-reloadable. */
  usageGapThresholdMinutes: number;
  /** Idle session timeout (minutes). Consecutive open-session intervals with no token movement exceeding this are treated as idle. Hot-reloadable. */
  usageIdleSessionTimeoutMinutes: number;
  /** Polling interval for /v1/models fetch (model weights + listing), in ms. */
  modelsRefreshMs: number;
  /** Persisted concurrency hard cap (from /v1/usage, editable for robustness testing). */
  concurrencyHardCap: number;
  /** Persisted concurrency soft limit (from /v1/usage, read-only display). */
  concurrencySoftLimit: number;
  /** When true, the effective limit is concurrencyHardCap (16); when false (default), it is concurrencySoftLimit (8). */
  useHardCap: boolean;
  /** Pro-tier rolling window: -1 = unlimited (no limiter), 0 = auto-derive from /v1/usage, >0 = explicit limit. */
  rateLimitRequests: number;
  /** Max time a request can wait in the queue before 503, in ms. */
  queueTimeoutMs: number;
  /** Max depth of the enqueued-waiters queue before 503-on-full. */
  maxQueueDepth: number;
  /** Cooldown after releasing a permit before reusing the slot, in ms. */
  releaseCooldownMs: number;
  /** Concurrency-429 count to trip the circuit breaker. */
  breakerThreshold: number;
  /** Time window for breaker 429 counting, in ms. */
  breakerWindowMs: number;
  /** Circuit breaker OPEN cooldown before HALF_OPEN probe, in ms. */
  breakerCooldownMs: number;
  /** Vision handoff strategy: never (off), catalog (model lookup), always. */
  visionStrategy: "never" | "catalog" | "always";
  /** URL of vision model API, or null to disable. */
  visionTarget: string | null;
  /** Model name sent to the vision API. */
  visionModel: string | null;
  /** Prompt sent to the vision model. */
  visionPrompt: string;
  /** Prompt version, for cache invalidation. */
  visionPromptVersion: number;
  /** Max images to process per request. */
  visionMaxImages: number;
  /** Max tokens for the description returned by the vision model. */
  visionMaxDescriptionTokens: number;
  /** Reasoning effort for vision model ("none"|"low"|"medium"|"high"). Null = don't send field. */
  visionReasoningEffort: "none" | "low" | "medium" | "high" | null;
  /** Timeout for vision model calls, in ms. */
  visionTimeoutMs: number;
  /** LRU cache size for vision descriptions. */
  visionCacheSize: number;
  /** TTL for vision cache entries (both in-memory and persistent), in ms. */
  visionCacheTtlMs: number;
  /** Hard row ceiling for the persistent vision cache table. */
  visionCacheMaxRows: number;
  /** Enable SQLite-backed persistent description cache. */
  visionPersistentCache: boolean;
  /** When true (catalog strategy), also intercept images for vision-capable
   *  models — converting them to cacheable text descriptions for KV cache
   *  efficiency and to bypass the 10-image-per-session limit. */
  visionForceInterceptCapable: boolean;
  /** Max concurrent vision-model API calls across all requests (default 1). */
  visionConcurrency: number;
  /** Max image dimension (longest side) after transcode, in pixels. */
  visionMaxDimension: number;
  /** JPEG quality 1–100 (used only when image_format is "jpeg"). */
  visionJpegQuality: number;
  /** Image format for transcoded images: "jpeg" (lossy) or "png" (lossless). */
  visionImageFormat: "jpeg" | "png";
  /** OpenAI image_url detail parameter: "auto", "low", or "high". */
  visionImageDetail: "auto" | "low" | "high";
  /** Intent-aware vision strategy (Task 9): gates HOW to prompt the vision model once `visionStrategy` has decided to intercept. */
  visionIntentStrategy: "off" | "slotted" | "crafted" | "auto";
  /** Whether multi-image decomposition (DecoVQA+) is enabled. */
  visionDecompositionEnabled: boolean;
  /** Timeout for the decomposition LLM call, in ms. */
  visionDecompositionTimeoutMs: number;
  /** Timeout for the crafting LLM call (Strategy D), in ms. */
  visionCraftingTimeoutMs: number;
  /** Max chars to extract from adjacent text blocks. */
  visionAdjacentTextMaxChars: number;
  /** Number of recent user messages to include in VisionContext.recentMessages. */
  visionRecentMessagesCount: number;
  /** Max chars to extract from the original system prompt. */
  visionSystemPromptMaxChars: number;
  /** When true, vision cache misses forward the original body and process vision in the background. */
  backgroundVision: boolean;
  /** Reserved concurrency slots for the "main" intention (default 1). */
  concurrencyMainReservation: number;
  /** Reserved concurrency slots for the "vision" intention (default 1). */
  concurrencyVisionReservation: number;
  /** Max captured request/response body size in bytes. 0 = unlimited. */
  captureBodyMaxBytes: number;
  /** Max depth of the write-behind response queue. Distinct from waiters queue. */
  queueMaxDepth: number;
  /** WebSocket backpressure limit in bytes. 0 = use Bun default. */
  wsBackpressureLimit: number;
  /** Close WebSocket connections that exceed the backpressure limit. */
  wsCloseOnBackpressureLimit: boolean;
  /** Max pending vision requests to batch together. */
  visionPendingMaxBatch: number;
  /** Enable zstd compression for captured text payloads. */
  compressionEnabled: boolean;
  /** Use a Bun Worker for write-behind batch updates (offloads event loop blocking). */
  useWriteWorker: boolean;
  /** Hard timeout for upstream requests in milliseconds. Prevents permit leaks when upstream hangs and client stays connected. */
  upstreamTimeoutMs: number;
  experimentRewriteIds: boolean;
  experimentRewriteTtlMs: number;
  /** When true, strips oh-my-openagent's [Category+Skill Reminder] injection from the first user message before forwarding upstream. */
  experimentStripOmoReminder: boolean;
  /** EXPERIMENTAL: Master toggle for TTFT-watchdog gated retry. */
  experimentTtftWatchdog: boolean;
  /** Watchdog threshold in ms — abort stalled fetches after this duration. */
  ttftTimeoutMs: number;
  /** Cap on total upstream attempts (2 = original + 1 retry, 3 = + rewrite escalation). */
  ttftRetryMaxAttempts: number;
  /** Suppress retry when gate active >= this percentage of soft limit. */
  ttftRetryGateSaturationPct: number;
  /** Cooldown between retries in ms. */
  ttftRetryCooldownMs: number;
  /** Multiplier applied to p50 TTFT to compute the dynamic watchdog threshold. Default 5. */
  ttftWatchdogMultiplier: number;
  /** Hard cap in ms for the dynamic watchdog threshold. Default 300000 (5 min). */
  ttftWatchdogHardCapMs: number;
  /** Number of latest captures per model used for performance percentile computation. */
  performanceSampleCount: number;
  /** Days to retain incident rows. Hot-reloadable. Default 30. */
  incidentRetentionDays: number;
}

// Narrow config interfaces (ISP). ProxyConfig structurally satisfies each,
// so the full config can be passed anywhere a narrow one is expected.

/** Upstream/incoming protocol fields — used by summary builders. */
export interface ProtocolConfig {
  incomingProtocol: ProxyConfig["incomingProtocol"];
  upstreamProtocol: ProxyConfig["upstreamProtocol"];
  upstreamTimeoutMs: ProxyConfig["upstreamTimeoutMs"];
}

/** Stamp-related fields used by the proxy stamp pipeline. */
export interface StampConfig {
  stampClaudeCode: ProxyConfig["stampClaudeCode"];
  stampGlm52Thinking: ProxyConfig["stampGlm52Thinking"];
  stampKimiK27CodeThinking: ProxyConfig["stampKimiK27CodeThinking"];
  stampReasoningEffort: ProxyConfig["stampReasoningEffort"];
  openaiPath: ProxyConfig["openaiPath"];
  experimentStripOmoReminder: ProxyConfig["experimentStripOmoReminder"];
}

/** Capture-related fields used by the proxy for body truncation + DB path. */
export interface CaptureConfig {
  target: ProxyConfig["target"];
  captureBodyMaxBytes: ProxyConfig["captureBodyMaxBytes"];
  maxCaptures: ProxyConfig["maxCaptures"];
  dbPath: ProxyConfig["dbPath"];
  backgroundVision: ProxyConfig["backgroundVision"];
}

/** Gate-related fields for concurrency/rate-limit/circuit-breaker tuning. */
export interface GateConfig {
  concurrencyHardCap: ProxyConfig["concurrencyHardCap"];
  concurrencySoftLimit: ProxyConfig["concurrencySoftLimit"];
  useHardCap: ProxyConfig["useHardCap"];
  rateLimitRequests: ProxyConfig["rateLimitRequests"];
  queueTimeoutMs: ProxyConfig["queueTimeoutMs"];
  maxQueueDepth: ProxyConfig["maxQueueDepth"];
  releaseCooldownMs: ProxyConfig["releaseCooldownMs"];
  breakerThreshold: ProxyConfig["breakerThreshold"];
  breakerWindowMs: ProxyConfig["breakerWindowMs"];
  breakerCooldownMs: ProxyConfig["breakerCooldownMs"];
  concurrencyMainReservation: ProxyConfig["concurrencyMainReservation"];
  concurrencyVisionReservation: ProxyConfig["concurrencyVisionReservation"];
}

export interface ExperimentConfig {
  experimentRewriteIds: ProxyConfig["experimentRewriteIds"];
  experimentRewriteTtlMs: ProxyConfig["experimentRewriteTtlMs"];
  experimentStripOmoReminder: ProxyConfig["experimentStripOmoReminder"];
  experimentTtftWatchdog: ProxyConfig["experimentTtftWatchdog"];
  ttftTimeoutMs: ProxyConfig["ttftTimeoutMs"];
  ttftRetryMaxAttempts: ProxyConfig["ttftRetryMaxAttempts"];
  ttftRetryGateSaturationPct: ProxyConfig["ttftRetryGateSaturationPct"];
  ttftRetryCooldownMs: ProxyConfig["ttftRetryCooldownMs"];
  ttftWatchdogMultiplier: ProxyConfig["ttftWatchdogMultiplier"];
  ttftWatchdogHardCapMs: ProxyConfig["ttftWatchdogHardCapMs"];
}

/** Write-behind queue flush fields used by WriteQueue. */
export interface QueueConfig {
  flushIntervalMs: ProxyConfig["flushIntervalMs"];
  flushBatch: ProxyConfig["flushBatch"];
  queueMaxDepth: ProxyConfig["queueMaxDepth"];
}

/** A cache_control block in an Anthropic message body. */
interface CacheControlBlock {
  type: string;
  ttl?: string;
}

/** Anthropic message content block that may carry cache_control. */
export interface ContentBlock {
  type?: string;
  text?: string;
  cache_control?: CacheControlBlock;
  [key: string]: unknown;
}

/**
 * Anthropic `thinking` block injected for matching models.
 *
 * Three variants are produced by the stamp pipeline:
 * - `adaptive`: the proxy's legacy adaptive thinking shape (used by
 *   `umans-coder`, `umans-flash`, `umans-qwen*`, and the fallback `*`
 *   policy when thinking is forced).
 * - `enabled` with `keep: "all"`: Kimi Preserved Thinking shape, used by
 *   `umans-kimi*` and `umans-coder` (both Kimi K2.7-Code base).
 *   See ADR-0017.
 * - `enabled` with `clear_thinking: false`: Z.ai Preserved Thinking shape,
 *   used by `umans-glm*`. See ADR-0017.
 */
export type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; keep: "all" }
  | { type: "enabled"; clear_thinking: boolean };

/** Anthropic `output_config` block injected for matching models. */
export interface OutputConfig {
  effort: "high" | "max";
}

/** Anthropic request body shape (subset we care about for TTL stamping). */
export interface AnthropicBody {
  system?: ContentBlock[] | string;
  messages?: Array<{ role: string; content: ContentBlock[] | string }>;
  max_tokens?: number;
  thinking?: ThinkingConfig;
  output_config?: OutputConfig;
  context_management?: { edits: Array<{ type: string; keep: string }> };
  [key: string]: unknown;
}

export interface OpenAiBody {
  model?: string;
  max_tokens?: number;
  thinking?: unknown;
  reasoning_effort?: string;
  temperature?: number;
  output_config?: unknown;
  context_management?: unknown;
  /** OpenAI streaming flag — true when the client wants a streaming response. */
  stream?: boolean;
  /** OpenAI streaming usage options. `include_usage: true` makes the API
   *  emit a final chunk with token counts. Without it, streaming requests
   *  report no usage at all. */
  stream_options?: { include_usage?: boolean } | null;
  [key: string]: unknown;
}

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

/** Discriminated state of the circuit breaker. */
export type BreakerState = "closed" | "open" | "half_open";

/** Stats snapshot for the dashboard gate panel. */
export interface GateStats {
  active: number;
  queued: number;
  softLimit: number;
  hardCap: number;
  /** Current effective operating limit (soft or hard, adjusted for priorityLow/boxing). */
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
