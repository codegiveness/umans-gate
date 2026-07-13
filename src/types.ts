// Shared types for the umans-gate capture proxy.

import type { UsageMetrics } from "./usage-extract.js";

/** HTTP protocol used for the upstream connection. */
export type UpstreamProtocol = "http2" | "http1.1";

/** HTTP protocol for incoming connections (always http1.1 without TLS). */
export type IncomingProtocol = "http1.1";

/** Capture state lifecycle. */
export type CaptureState = "enqueued" | "streaming" | "done";

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
}

/** WebSocket message types broadcast to connected inspector clients. */
export type WsMessage =
  | { type: "new"; capture: CaptureSummary }
  | { type: "update"; capture: CaptureSummary }
  | { type: "state"; captureId: number; state: CaptureState }
  | { type: "gate"; stats: GateStats }
  | { type: "clear" }
  | { type: "vision-clear" };

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
  /** Polling interval for /v1/usage reconciliation, in ms. */
  usageRefreshMs: number;
  /** Polling interval for /v1/models fetch (model weights + listing), in ms. */
  modelsRefreshMs: number;
  /** Persisted concurrency hard cap (from /v1/usage, editable for robustness testing). */
  concurrencyHardCap: number;
  /** Persisted concurrency soft limit (from /v1/usage, read-only display). */
  concurrencySoftLimit: number;
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
  stampReasoningEffort: ProxyConfig["stampReasoningEffort"];
  openaiPath: ProxyConfig["openaiPath"];
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

/** Anthropic `thinking` block injected for matching models. */
export interface ThinkingConfig {
  type: "adaptive";
}

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
  reasoning_effort?: "high" | "max";
  [key: string]: unknown;
}

/** Snapshot of /v1/usage response (subset we care about). */
export interface UsageSnapshot {
  ok: boolean;
  fetchedAt: number;
  plan: "Code Pro" | "Code Max" | "unknown";
  requestsLimit: number | null;
  requestsHardCap: number | null;
  requestsWindowSeconds: number | null;
  concurrencySoftLimit: number;
  concurrencyHardCap: number;
  requestsInWindow: number;
  requestsRemaining: number | null;
  concurrentSessions: number;
  priorityLow: boolean;
  boxedUntil: number | null;
  boxedReason: string | null;
  unitsDemoted: boolean;
  demotedUntil: number | null;
}

/** Discriminated state of the circuit breaker. */
export type BreakerState = "closed" | "open" | "half_open";

/** Stats snapshot for the dashboard gate panel. */
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
}
