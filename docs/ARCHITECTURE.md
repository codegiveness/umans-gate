# Architecture

> **Applies to:** umans-gate v0.3.19 · **Last updated:** 2026-07-25

This document describes the system architecture, data flow, and key design
decisions of umans-gate.

## Overview

umans-gate is a Bun-based LLM capture proxy. It sits between your LLM harness
and the upstream API (Anthropic + OpenAI-compatible), intercepting traffic to
capture, stamp, and optionally transform requests before forwarding.

```
┌──────────┐     HTTP      ┌─────────────┐     HTTP/1.1 or HTTP/2     ┌──────────────┐
│  Client   │ ────────────▶ │ umans-gate  │ ──────────────────────────▶ │  Upstream    │
│ (harness) │ ◀──────────── │   proxy     │ ◀────────────────────────── │  (Umans API) │
└──────────┘   SSE stream   └──────┬──────┘     SSE stream            └──────────────┘
                                   │
                           ┌───────┴───────┐
                           │ SQLite        │  capture store (WAL, ring buffer)
                           │ umans-gate.db │
                           └───────────────┘
                                   │
                             ┌─────┴─────┐
                             │ WebSocket │  live updates to dashboard
                             │ broadcaster│
                             └───────────┘
                                   │
                             ┌─────┴─────┐
                             │ Dashboard  │  React SPA (shadcn/ui)
                             │  :1945     │
                             └───────────┘
```

## Request Flow

### 1. Incoming Request

```
Client → Bun.serve (port 1945) → proxy handler (src/proxy.ts)
```

- `Bun.serve` listens on the configured port with `reusePort: true`
- Per-request `timeout(0)` disables idle timeout for proxy routes (SSE-safe)
- Dashboard routes (`/dashboard/*`) are handled by `viewer.ts` instead

### 2. Body Parsing & Stamping

```
proxy.ts → parse body → stamp pipeline → vision handoff → forward upstream
```

The stamp pipeline (`src/stamp-pipeline.ts`) applies modifications in a
defined order when `stamp_claude_code_enabled` is on:

1. **TTL stamping** (`stamp.ts`) — adds `ttl` to `cache_control` ephemeral blocks
2. **`top_k` injection** (`stamp-topk.ts`) — injects `top_k: 20` after `model`
3. **`temperature` stamping** (`stamp-temperature.ts`) — forces `temperature: 1.0`
4. **`max_tokens` / `thinking` / `output_config`** (`stamp-thinking.ts`) — model-aware injection
5. **`context_management`** — injected when `anthropic-version` is `2023-06-01`

For OpenAI-compatible requests, `stamp-reasoning.ts` handles
`reasoning_effort` injection separately.

```
                        STAMP PIPELINE (stamp_claude_code_enabled = true)
                        ────────────────────────────────────────────────────

  Anthropic request body
        │
        ▼
┌───────────────────┐
│ 1. TTL stamping   │  stamp.ts
│   + ttl:"1h" on   │  → cache_control ephemeral blocks
│     ephemeral     │
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ 2. top_k injection│  stamp-topk.ts
│   + top_k: 20     │  → injected after model field
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ 3. temperature    │  stamp-temperature.ts
│   = 1.0 (forced)  │
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ 4. max_tokens     │  stamp-thinking.ts
│   + thinking      │  → umans-glm* models: 131071
│   + output_config  │     others: 32767
│                   │  → thinking: { type: "adaptive" }
│                   │     (umans-coder/flash/kimi*/qwen*)
│                   │  → output_config: { effort: "high"|"max" }
└───────┬───────────┘
        │
        ▼
┌───────────────────┐
│ 5. context_mgmt   │  injected when anthropic-version = 2023-06-01
│   + clear_thinking │  → { edits: [{ type: clear_thinking_20251015,
│     keep: "all"   │       keep: "all" }] }
└───────┬───────────┘
        │
        ▼
  Stamped body ──────────► forwarded upstream AND captured
                          (inspector shows exactly what went to API)


  OpenAI-compatible request body
        │
        ▼
┌───────────────────┐
│ reasoning_effort  │  stamp-reasoning.ts
│ + high / max      │  → high (default), max (umans-glm*)
│ - max_tokens      │  → removes max_tokens + thinking
│ - thinking        │
└───────────────────┘
```

### 3. Vision Handoff

```
proxy.ts → vision/handoff.ts → detect images → extract context → triage strategy
  → [transcode → vision model] → cache → replace blocks
```

When `vision_strategy` is `catalog` or `always`:

1. `detect.ts` finds image blocks in Anthropic or OpenAI request bodies and
   extracts context (`adjacentText`, `isToolResult`, `positionInBatch`,
   `batchSize`, `originalSystemPrompt`)
2. `triage.ts` deterministically routes the request to one of four strategies
   (`generic`, `slotted`, `crafted`, `decomposed`) based on the extracted context
3. Images are transcoded to PNG/JPEG (`transcode.ts`) with max dimension
4. Each image is sent to the vision model (`umans-flash`) via the concurrency gate
   with a strategy-appropriate prompt (crafted/decomposed may make a preceding
   LLM call to reformulate the question, cached in-memory)
5. Descriptions are cached in-memory (`cache.ts`) and persistently (`persistent-cache.ts`)
6. Image blocks are replaced with text descriptions (`wrapper.ts`)

Vision calls are serialized by a `ConcurrencyGate` with configurable
concurrency (default: 1) because the upstream has limited vision slots.

### 4. Upstream Forward

```
proxy.ts → fetch(upstream, { protocol, signal }) → SSE stream → TransformStream → client
```

- Upstream protocol: HTTP/1.1 (default) or HTTP/2 (configurable)
- `AbortSignal` forwarded: client disconnect cancels upstream immediately
- Response streamed via `TransformStream` — captured chunk-by-chunk
- `accept-encoding: identity` forced (no gzip — capture safety)

### 5. Capture & Storage

```
TransformStream → write-behind queue → worker → SQLite (WAL)
```

- Request/response bodies captured at the TransformStream layer
- WriteQueue (`src/queue.ts`) batches writes to minimize I/O blocking
- Worker pipeline (`src/workers/`) offloads capture writes from the main thread
- Bodies optionally compressed with zstd (`src/compress.ts`)
- Ring buffer: oldest captures evicted when `max_captures` is exceeded

### 6. WebSocket Broadcast

```
WriteQueue flush → ws.ts broadcast → dashboard clients
```

- On each queue flush, WebSocket messages (`new`, `update`, `clear`) are sent
- Backpressure limit protects against slow clients
- Configurable auto-close on backpressure exceedance

## Concurrency Gate

```
src/limiter/gate.ts — ConcurrencyGate
├── Semaphore (src/limiter/gate.ts)
│   ├── Soft limit (driven by /v1/usage)
│   ├── Hard cap (configurable)
│   ├── Intention-based reservations (main vs vision)
│   └── Queue with timeout
├── CircuitBreaker (src/limiter/circuit-breaker.ts)
│   ├── Opens after N 429s in window
│   ├── Cooldown before half-open
│   └── Half-open probe
└── Stats emission
```

The gate is the central concurrency controller. It prevents overwhelming the
upstream by:

- Enforcing a soft limit (adjusted by `/v1/usage` reconciliation)
- Hard cap as an absolute ceiling (transient over-cap allowed during drain)
- Circuit breaker to stop traffic when the upstream returns repeated 429s
- Intention-based reservations ensure vision calls don't starve main requests

## Usage Tracking

```
src/usage.ts → /v1/usage fetch → reconcile → resize gate → rate limiter
src/usage-extract.ts → extract from capture bodies (provider×streaming)
```

- Polls `/v1/usage` at `usage_refresh_ms` intervals
- Reconciles concurrency limits based on remaining quota
- Detects rate-boxing (when the upstream indicates the account is boxed)
- Manages priority demotion when the account is under pressure

## Rate Limiting

```
src/rate.ts — SlidingWindowRateLimiter
├── Weighted entries (each request consumes `weight` units)
├── Binary-search pruning for expired entries
├── check() — records and returns allow/deny
└── peek() — checks without recording
```

- `rate_limit_requests: 0` — auto-derive window and limit from `/v1/usage`
- `-1` — disabled (no limiter)
- `>0` — explicit limit with sliding window

## Dashboard

```
dashboard/ — Vite + React + TypeScript + Tailwind + shadcn/ui
├── Capture list (live WebSocket updates)
├── Capture detail (request/response body viewer, SSE event preview)
├── Config tab (validation, hot-reload, restart)
├── Stats (gate state, usage, rate limit)
└── Polling hooks (usePollingResource, useCaptureList, useCaptureDetail, useGateStats)
```

The dashboard communicates with the backend via:
- REST: `GET /dashboard/api/captures`, `GET /dashboard/api/captures/:id`,
  `POST /dashboard/api/clear`, `POST /dashboard/api/config`,
  `POST /dashboard/api/config/reload`, `POST /dashboard/api/restart`
- WebSocket: `WS /dashboard/ws` (`new`, `update`, `clear` messages)

## Design Principles

- **SOLID**: modules have single responsibility, extensibility via new modules
  not edits to existing ones, narrow interfaces, dependency injection
- **Bun-native**: uses `bun:sqlite`, `Bun.serve`, Bun's `fetch` with `protocol`
  option — no Node.js compatibility layer
- **Capture-first**: the proxy never modifies the response body (only captures
  it). Request body modifications are gated by config flags and default off
- **Non-blocking streaming**: writes are batched and offloaded to workers;
  the TransformStream never blocks the response

## Related: umans-open-stack

umans-gate implements patterns documented in
[umans-open-stack](https://github.com/umans-ai/umans-open-stack) — a curated set of
open source tools and playbooks. The architecture maps to open-stack
playbooks:

| umans-open-stack playbook | umans-gate implementation |
|---|---|
| Concurrency | Concurrency gate (semaphore + circuit breaker in `src/limiter/gate.ts`) |
| Caching | `cache_control` TTL stamping pipeline (`src/stamp.ts`) |
| Vision-handoff | Image → text description pipeline (`src/vision/handoff.ts`) |
| Workflows | Capture-and-replay architecture (`src/db.ts`, `src/proxy.ts`) |

See the [umans-open-stack repository](https://github.com/umans-ai/umans-open-stack)
for playbooks and configuration examples.
