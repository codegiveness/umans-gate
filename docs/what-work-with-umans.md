# What Works With umans-gate

> **Applies to:** umans-gate v0.4.2 · **Last updated:** 2026-07-27

Maps umans-gate v0.3.27 — a Bun-based LLM capture proxy — to the
[umans-open-stack](https://github.com/umans-ai/umans-open-stack) playbook
categories.

> **When to read this:** read this if you follow the
> [umans-open-stack](https://github.com/umans-ai/umans-open-stack) playbooks
> and want to see how umans-gate's features map to them. Otherwise skip —
> the primary documentation in [README.md](../README.md) and
> [ARCHITECTURE.md](ARCHITECTURE.md) covers standalone use.

umans-gate is a **proxy**, not a configuration. It does not "implement" the
playbooks below. It **provides building blocks** — observable, stamping-aware
infrastructure — that align with the patterns the playbooks describe.

## umans-open-stack playbooks

| Playbook | URL |
|---|---|
| Concurrency | https://github.com/umans-ai/umans-open-stack/blob/main/playbooks/concurrency.md |
| Vision handoff | https://github.com/umans-ai/umans-open-stack/blob/main/playbooks/vision-handoff.md |
| Caching | https://github.com/umans-ai/umans-open-stack/blob/main/playbooks/caching.md |
| Images | https://github.com/umans-ai/umans-open-stack/blob/main/playbooks/images.md |
| Workflows | https://github.com/umans-ai/umans-open-stack/blob/main/playbooks/workflows.md |

## Feature Mappings

### 1. Concurrency Gate — aligns with the concurrency playbook

**Source files**

- `src/limiter/gate.ts` — `ConcurrencyGate`
- `src/limiter/circuit-breaker.ts` — `CircuitBreaker`
- `src/rate.ts` — `RateLimiter`

**Alignment**

The concurrency playbook describes bounded in-flight request control with
priority budgets and failure isolation. umans-gate provides these as live,
hot-reloadable building blocks:

- Hard cap (`concurrency_hard_cap`, default 16) and soft limit
  (`concurrency_soft_limit`, default 8) with `use_hard_cap` toggle
- Main + vision reservations (`concurrency_main_reservation`,
  `concurrency_vision_reservation`) — separate budgets per traffic class
- Circuit breaker (`breaker_threshold`, `breaker_window_ms`,
  `breaker_cooldown_ms`) for failure isolation
- Rate limiter (`rate_limit_requests`) for request-per-window caps
- Live gate stats broadcast over WebSocket (`type: "gate"`)

The gate is observable in the dashboard (GET /dashboard/api/gate) and
hot-reloadable — operators can tune caps without restart.

### 2. Vision Handoff — provides building blocks for the vision-handoff playbook

**Source files**

- `src/vision/handoff.ts` — `VisionHandoff` (class), `VisionConfig` (interface)
- `src/vision/detect.ts` — image detection
- `src/vision/triage.ts` — request triage
- `src/vision/sink.ts` — WS broadcast
- `src/vision/image-processor.ts` — image preprocessing

**Alignment**

The vision-handoff playbook describes offloading image-bearing requests to a
description-generation step. umans-gate provides the full handoff pipeline:

- Detect image content in intercepted requests
- Triage to decide which need description
- Generate descriptions async via `vision_model` (default `umans-flash`)
- Cache descriptions persistently (`vision_cache_max_rows`, `vision_cache_ttl_ms`)
- Stream results to dashboard via WebSocket (`new`, `update`, `vision-clear`)

The 7 intent-aware vision fields (`vision_intent_strategy`,
`vision_decomposition_*`, `vision_adjacent_text_max_chars`, etc.) let operators
tune decomposition and crafting timeouts — directly relevant to the
vision-handoff playbook's intent-aware patterns.

### 3. cache_control TTL Stamping — aligns with the caching playbook

**Source files**

- `src/stamp.ts` — `stampTtl` and core stamping
- `src/stamp-pipeline.ts` — stamp orchestration
- `src/stamp-catalog.ts` — `matchStampOverlay`, `StampPolicy`
- `src/model-info-parser.ts` — `parseModelInfoResponse`

**Alignment**

The caching playbook describes explicit cache boundary management on
Anthropic `cache_control` ephemeral blocks. umans-gate **stamps `ttl`** onto
every `cache_control` ephemeral block in intercepted Anthropic requests —
the TTL is always set, independent of thinking state (per ADR-0011).

Stamping is per-model policy driven:
- `stamp_claude_code_enabled` toggles Claude Code stamping
- `stamp_reasoning_effort_enabled` toggles OpenAI reasoning_effort stamping
- `StampPolicy` overlay (from `stamp-catalog.ts`) decides thinking, max_tokens,
  temperature, top_k, output_config, context_management per model
- Model info from `/v1/models/info` (parsed by `model-info-parser.ts`)
  overrides overlay at parse time

This is observable infrastructure for the caching playbook's patterns:
operators can see (Captures tab) exactly which blocks got TTL stamped and
verify cache boundaries match their playbook.

### 4. SSE Streaming + Rendering — provides building blocks for the workflows playbook

**Source files**

- `src/proxy.ts` — streaming response handling (SSE passthrough + capture)
- `dashboard/src/components/sse-viewer.tsx` — `SseViewer`
- `dashboard/src/components/body-renderer.tsx` — `BodyRenderer`

**Alignment**

The workflows playbook describes multi-step LLM workflows with streaming
intermediates. umans-gate provides transparent SSE passthrough with full
chunk capture:

- Streams SSE chunks to client without buffering whole response
- Captures each chunk to `CaptureDB` via `WriteQueue` (non-blocking)
- Dashboard `SseViewer` renders the raw event stream with token boundaries
- `state` WebSocket messages signal `streaming` / `failed` transitions

Operators building workflows can inspect intermediate streams, verify token
flow, and debug stuck workflows — without modifying the proxy.

### 5. Write-Behind Queue — provides building blocks for the workflows playbook

**Source files**

- `src/queue.ts` — `WriteQueue`

**Alignment**

The workflows playbook describes non-blocking persistence for high-throughput
streams. umans-gate's `WriteQueue` batches capture writes:

- Buffer captures in memory, flush in batches to SQLite
- `queue_max_depth` (default 100) caps buffer size
- `queue_timeout_ms` (default 180000) bounds flush latency
- Broadcasts `update` WebSocket messages on flush (src/queue.ts:208)

This decouples proxy latency from persistence — the workflows playbook's
"don't block the hot path" pattern. Operators can tune depth/timeout live.

### 6. Ring-Buffered Capture Store — aligns with the caching playbook

**Source files**

- `src/db.ts` — `CaptureDB` (WAL mode, ring buffer)
- `src/index.ts:319` — prune broadcast (`type: "prune"`)

**Alignment**

The caching playbook describes bounded retention with eviction. umans-gate's
`CaptureDB` is a ring-buffered SQLite store:

- `max_captures` (default 200) caps row count
- WAL mode for concurrent read/write
- Pruning broadcasts `prune` messages with evicted IDs
- `capture_body_max_bytes` (default 10MB) bounds per-capture size

This is the storage-side caching pattern: bounded working set, eviction
observable by dashboard clients. Aligns with the caching playbook's retention
patterns for inspection data.

### 7. Connection Warmer — aligns with the concurrency playbook

**Source files**

- `src/warmer.ts` — `ConnectionWarmer`

**Alignment**

The concurrency playbook describes connection pre-warming to avoid cold-start
latency under burst. umans-gate's `ConnectionWarmer`:

- `warmer_enabled` (default true)
- `warmer_interval_ms` (default 20000) — keep-alive cadence
- Maintains upstream connection pool health

Reduces TTFT variance under burst — directly relevant to the concurrency
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
Operators can observe each in the dashboard before committing to a playbook
configuration in their own application.

## See Also

- `docs/reference/` — per-tab reference (captures, vision, performance,
  economics, usage, models, config)
- `docs/adr/` — 18 architecture decision records
- `AGENTS.md` — contributor guide with stamping truth tables (ADR-0011)
