# Architecture

> **Applies to:** umans-gate v0.5.0 · **Last updated:** 2026-07-28

umans-gate is a Bun-based capture proxy that sits between an LLM harness and
the upstream API, intercepting traffic to capture, stamp, and optionally
transform requests before forwarding.

> ⚠️ Experimental: enabled by `stamp_claude_code_enabled` (default: off)

## What is the system layout?

umans-gate has four layers: the Bun HTTP server, the stamp/vision pipeline,
the SQLite capture store with a write-behind queue, and the React dashboard
updated over WebSocket.

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

## How does a request flow?

### 1. Incoming Request

```
Client → Bun.serve (port 1945) → proxy handler (src/proxy.ts)
```

`Bun.serve` listens on the configured port with `reusePort: true`, and per-request
`timeout(0)` disables idle timeout for proxy routes so SSE streams are not killed.
Dashboard routes (`/dashboard/*`) are handled by `viewer.ts` instead.

### 2. Body Parsing & Stamping

```
proxy.ts → parse body → stamp pipeline → vision handoff → forward upstream
```

The stamp pipeline (`src/stamp-pipeline.ts`) applies modifications in this
order when `stamp_claude_code_enabled` is on:

1. **TTL stamping** (`stamp.ts`): adds `ttl` to `cache_control` ephemeral blocks
2. **`top_k` injection** (`stamp-topk.ts`): injects `top_k: 20` after `model`
3. **`temperature` stamping** (`stamp-temperature.ts`): forces `temperature: 1.0`
4. **`max_tokens` / `thinking` / `output_config`** (`stamp-thinking.ts`): model-aware injection
5. **`context_management`**: injected when `stamp_claude_code_enabled` is on, route is Anthropic, and thinking is enabled

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
│ 5. context_mgmt   │  injected when stampClaudeCode && !isOpenAi && thinking enabled
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

When `vision_strategy` is `catalog` or `always`, vision handoff runs in six
steps:

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

Upstream forwarding streams the response chunk-by-chunk through a
`TransformStream`:

- Upstream protocol: HTTP/1.1 (default) or HTTP/2 (configurable)
- `AbortSignal` forwarded: client disconnect cancels upstream immediately
- Response streamed via `TransformStream`, captured chunk-by-chunk
- `accept-encoding: identity` forced (no gzip, capture safety)

### 5. Capture & Storage

```
TransformStream → write-behind queue → worker → SQLite (WAL)
```

Capture and storage happens at the `TransformStream` layer:

- Request/response bodies captured at the TransformStream layer
- WriteQueue (`src/queue.ts`) batches writes to minimize I/O blocking
- Worker pipeline (`src/workers/`) exists but is disabled (`useWriteWorker = false` in config/loader.ts)
- Bodies optionally compressed with zstd (`src/compress.ts`)
- Ring buffer: oldest captures evicted when `max_captures` is exceeded

### 6. WebSocket Broadcast

```
WriteQueue flush → ws.ts broadcast → dashboard clients
```

WebSocket broadcast sends live updates to the dashboard on every queue flush:

- On each queue flush, WebSocket messages (`new`, `update`, `clear`) are sent
- Backpressure limit protects against slow clients
- Configurable auto-close on backpressure exceedance

## How does the concurrency gate work?

```
src/limiter/gate.ts: ConcurrencyGate
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

The concurrency gate is the central upstream traffic controller. It prevents
overwhelming the upstream by:

- Enforcing a soft limit (adjusted by `/v1/usage` reconciliation)
- Hard cap as an absolute ceiling (transient over-cap allowed during drain)
- Circuit breaker to stop traffic when the upstream returns repeated 429s
- Intention-based reservations ensure vision calls don't starve main requests

## How does usage tracking work?

```
src/usage.ts → /v1/usage fetch → reconcile → resize gate → rate limiter
src/usage-extract.ts → extract from capture bodies (provider×streaming)
```

Usage tracking polls the upstream account state and resizes local limits:

- Polls `/v1/usage` at `usage_refresh_ms` intervals
- Reconciles concurrency limits based on remaining quota
- Detects rate-boxing (when the upstream indicates the account is boxed)
- Manages priority demotion when the account is under pressure

## How does rate limiting work?

```
src/rate.ts: SlidingWindowRateLimiter
├── Weighted entries (each request consumes `weight` units)
├── Binary-search pruning for expired entries
├── check(): records and returns allow/deny
└── peek(): checks without recording
```

The rate limiter is a sliding-window weighted counter with three modes:

- `rate_limit_requests: 0`: auto-derive window and limit from `/v1/usage`
- `-1`: disabled (no limiter)
- `>0`: explicit limit with sliding window

## How does the dashboard work?

```
dashboard/: Vite + React + TypeScript + Tailwind + shadcn/ui
├── Capture list (live WebSocket updates)
├── Capture detail (request/response body viewer, SSE event preview)
├── Config tab (validation, hot-reload, restart)
├── Stats (gate state, usage, rate limit)
└── Polling hooks (usePollingResource, useCaptureList, useCaptureDetail, useGateStats)
```

The dashboard is a React SPA that communicates with the backend via REST and
WebSocket:

- REST: `GET /dashboard/api/captures`, `GET /dashboard/api/captures/:id`,
  `POST /dashboard/api/clear`, `POST /dashboard/api/config`,
  `POST /dashboard/api/config/reload`, `POST /dashboard/api/restart`
- WebSocket: `WS /dashboard/ws` (`new`, `update`, `clear` messages)

## What are the design principles?

- **SOLID**: modules have single responsibility, extensibility via new modules
  not edits to existing ones, narrow interfaces, dependency injection
- **Bun-native**: uses `bun:sqlite`, `Bun.serve`, Bun's `fetch` with `protocol`
  option, no Node.js compatibility layer
- **Capture-first**: the proxy never modifies the response body (only captures
  it). Request body modifications are gated by config flags and default off
- **Non-blocking streaming**: writes are batched and offloaded to workers;
  the TransformStream never blocks the response

## How does umans-gate map to umans-open-stack?

umans-gate implements patterns documented in
[umans-open-stack](https://github.com/umans-ai/umans-open-stack):

| umans-open-stack playbook | umans-gate implementation |
|---|---|
| Concurrency | Concurrency gate (semaphore + circuit breaker in `src/limiter/gate.ts`) |
| Caching | `cache_control` TTL stamping pipeline (`src/stamp.ts`) |
| Vision-handoff | Image → text description pipeline (`src/vision/handoff.ts`) |
| Workflows | Capture-and-replay architecture (`src/db.ts`, `src/proxy.ts`) |

See the [umans-open-stack repository](https://github.com/umans-ai/umans-open-stack)
for playbooks and configuration examples.
