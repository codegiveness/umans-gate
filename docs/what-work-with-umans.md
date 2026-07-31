# What works with umans-gate

> **Applies to:** umans-gate v0.6.0 · **Last updated:** 2026-07-31

This document maps umans-gate v0.5.6, a Bun-based LLM capture proxy, to the
[umans-open-stack](https://github.com/umans-ai/umans-open-stack) playbook
categories.

> **When to read this:** read this if you follow the
> [umans-open-stack](https://github.com/umans-ai/umans-open-stack) playbooks
> and want to see how umans-gate's features map to them. Otherwise skip:
> the primary documentation in [README.md](../README.md) and
> [ARCHITECTURE.md](ARCHITECTURE.md) covers standalone use.

umans-gate is a **proxy**, not a configuration. It does not implement the
playbooks below. It provides observable, stamping-aware infrastructure that
aligns with the patterns the playbooks describe.

## umans-open-stack playbooks

| Playbook | URL |
|---|---|
| Concurrency | https://github.com/umans-ai/umans-open-stack/blob/main/playbooks/concurrency.md |
| Vision handoff | https://github.com/umans-ai/umans-open-stack/blob/main/playbooks/vision-handoff.md |
| Caching | https://github.com/umans-ai/umans-open-stack/blob/main/playbooks/caching.md |
| Images | https://github.com/umans-ai/umans-open-stack/blob/main/playbooks/images.md |
| Workflows | https://github.com/umans-ai/umans-open-stack/blob/main/playbooks/workflows.md |

## Feature mappings

### 1. Concurrency Gate: aligns with the concurrency playbook

**Source files**

- `src/limiter/gate.ts`: `ConcurrencyGate`
- `src/limiter/circuit-breaker.ts`: `CircuitBreaker`
- `src/rate.ts`: `RateLimiter`

**Alignment**

umans-gate provides bounded in-flight request control, priority budgets,
and failure isolation as live, hot-reloadable building blocks:

- Hard cap (`concurrency_hard_cap`, default 16) and soft limit
  (`concurrency_soft_limit`, default 8) with `use_hard_cap` toggle
- Main + vision reservations (`concurrency_main_reservation`,
  `concurrency_vision_reservation`): separate budgets per traffic class
- Circuit breaker (`breaker_threshold`, `breaker_window_ms`,
  `breaker_cooldown_ms`) for failure isolation
- Rate limiter (`rate_limit_requests`) for request-per-window caps
- Live gate stats broadcast over WebSocket (`type: "gate"`)

The gate is observable in the dashboard at `GET /dashboard/api/gate` and
hot-reloadable. Operators can tune caps without restart.

### 2. Vision Handoff: provides building blocks for the vision-handoff playbook

**Source files**

- `src/vision/handoff.ts`: `VisionHandoff` (class), `VisionConfig` (interface)
- `src/vision/detect.ts`: image detection
- `src/vision/triage.ts`: request triage
- `src/vision/sink.ts`: WS broadcast
- `src/vision/image-processor.ts`: image preprocessing

**Alignment**

umans-gate provides the full image-to-text handoff pipeline:

- Detect image content in intercepted requests
- Triage to decide which images need description
- Generate descriptions async via `vision_model` (default `umans-flash`)
- Cache descriptions persistently (`vision_cache_max_rows`, `vision_cache_ttl_ms`)
- Stream results to dashboard via WebSocket (`new`, `update`, `vision-clear`)

The 7 intent-aware vision fields (`vision_intent_strategy`,
`vision_decomposition_*`, `vision_adjacent_text_max_chars`, etc.) let operators
tune decomposition and crafting timeouts.

### 3. cache_control TTL Stamping: aligns with the caching playbook

**Source files**

- `src/stamp.ts`: `stampTtl` and core stamping
- `src/stamp-pipeline.ts`: stamp orchestration
- `src/stamp-catalog.ts`: `matchStampOverlay`, `StampPolicy`
- `src/model-info-parser.ts`: `parseModelInfoResponse`

**Alignment**

> ⚠️ Experimental: enabled by `stamp_claude_code_enabled` (default: off)

umans-gate stamps `ttl` onto every `cache_control` ephemeral block in
intercepted Anthropic requests. The TTL is always set, independent of
thinking state (per ADR-0011).

Stamping is per-model policy driven:
- `stamp_claude_code_enabled` toggles Claude Code stamping
- `stamp_reasoning_effort_enabled` toggles OpenAI reasoning_effort stamping
- `StampPolicy` overlay (from `stamp-catalog.ts`) decides thinking, max_tokens,
  temperature, top_k, output_config, context_management per model
- Model info from `/v1/models/info` (parsed by `model-info-parser.ts`)
  overrides overlay at parse time

This is observable infrastructure: operators can see in the Captures tab
exactly which blocks got TTL stamped and verify cache boundaries match
their playbook.

### 4. SSE Streaming + Rendering: provides building blocks for the workflows playbook

**Source files**

- `src/proxy.ts`: streaming response handling (SSE passthrough + capture)
- `dashboard/src/components/sse-viewer.tsx`: `SseViewer`
- `dashboard/src/components/body-renderer.tsx`: `BodyRenderer`

**Alignment**

umans-gate provides transparent SSE passthrough with full chunk capture:

- Streams SSE chunks to client without buffering whole response
- Captures each chunk to `CaptureDB` via `WriteQueue` (non-blocking)
- Dashboard `SseViewer` renders the raw event stream with token boundaries
- `state` WebSocket messages signal `streaming` / `failed` transitions

Operators building workflows can inspect intermediate streams, verify token
flow, and debug stuck workflows, without modifying the proxy.

### 5. Write-Behind Queue: provides building blocks for the workflows playbook

**Source files**

- `src/queue.ts`: `WriteQueue`

**Alignment**

umans-gate's `WriteQueue` batches capture writes for non-blocking persistence:

- Buffer captures in memory, flush in batches to SQLite
- `queue_max_depth` (default 100) caps buffer size
- `queue_timeout_ms` (default 180000) bounds flush latency
- Broadcasts `update` WebSocket messages on flush (`src/queue.ts:208`)

This decouples proxy latency from persistence, the workflows playbook's
"don't block the hot path" pattern. Operators can tune depth/timeout live.

### 6. Ring-Buffered Capture Store: aligns with the caching playbook

**Source files**

- `src/db.ts`: `CaptureDB` (WAL mode, ring buffer)
- `src/index.ts:319`: prune broadcast (`type: "prune"`)

**Alignment**

umans-gate's `CaptureDB` is a ring-buffered SQLite store with bounded
retention:

- `max_captures` (default 200) caps row count
- WAL mode for concurrent read/write
- Pruning broadcasts `prune` messages with evicted IDs
- `capture_body_max_bytes` (default 10MB) bounds per-capture size

This is the storage-side caching pattern: bounded working set, eviction
observable by dashboard clients. It aligns with the caching playbook's
retention patterns for inspection data.

### 7. Connection Warmer: aligns with the concurrency playbook

**Source files**

- `src/warmer.ts`: `ConnectionWarmer`

**Alignment**

umans-gate's `ConnectionWarmer` pre-warms upstream connections to avoid
cold-start latency under burst:

- `warmer_enabled` (default true)
- `warmer_interval_ms` (default 20000): keep-alive cadence
- Maintains upstream connection pool health

This reduces TTFT variance under burst, directly relevant to the concurrency
playbook's pre-warming guidance.

## Summary

| # | Feature | Source file(s) | Playbook |
|---|---|---|---|
| 1 | Concurrency gate | src/limiter/gate.ts, src/limiter/circuit-breaker.ts, src/rate.ts | concurrency |
| 2 | Vision handoff | src/vision/handoff.ts, src/vision/detect.ts, src/vision/triage.ts | vision-handoff |
| 3 | cache_control TTL stamping | src/stamp.ts, src/stamp-pipeline.ts, src/stamp-catalog.ts | caching |
| 4 | SSE streaming + rendering | src/proxy.ts, dashboard/src/components/sse-viewer.tsx | workflows |
| 5 | Write-behind queue | src/queue.ts | workflows |
| 6 | Ring-buffered capture store | src/db.ts | caching |
| 7 | Connection warmer | src/warmer.ts | concurrency |

All 7 features are hot-reloadable or runtime-tunable via the Config tab.
Operators can observe each one in the dashboard before committing to a
playbook configuration in their own application.

## See also

- `docs/reference/`: per-tab reference (captures, vision, performance,
  economics, usage, models, config)
- `docs/adr/`: 29 architecture decision records
- `AGENTS.md`: contributor guide with stamping truth tables (ADR-0011)
