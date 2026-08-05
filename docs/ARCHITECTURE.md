# Architecture

> **Applies to:** umans-gate v0.6.1 · **Last updated:** 2026-07-31

umans-gate is a Bun-based capture proxy that sits between an LLM harness and
the upstream API, intercepting traffic to capture, stamp, and optionally
transform requests before forwarding.

> ⚠️ Experimental: enabled by `stamp_claude_code_enabled` (default: on)

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
order when `stamp_claude_code_enabled` is on (Anthropic route):

1. **Restamp breakpoints** (`restamp-breakpoints.ts`): re-layout `cache_control` breakpoints to Layout B (system[0] + last user message) before TTL stamping. See ADR 0002.
2. **TTL stamping** (`stamp.ts`): adds `ttl` to `cache_control` ephemeral blocks
3. **Anthropic body** (`stamp-thinking.ts`): injects `max_tokens`, `thinking` (adaptive overlay), `output_config`; strips `reasoning_effort` if present
4. **Per-model rule** (`stamp-catalog.ts` `resolvePerModelRule`): overrides `thinking` shape per model family from `stamp_model_rules` (ADR-0029). Independent of master toggles — fires whenever a matching rule exists.
5. **`context_management`**: injected when thinking is enabled after per-model rules
6. **`top_k` injection** (`stamp-topk.ts`): injects `top_k: 20` after `model`
7. **`temperature` stamping** (`stamp-temperature.ts`): forces `temperature: 1.0` when thinking is enabled

For OpenAI-compatible requests, `stamp-reasoning.ts` handles
`reasoning_effort` injection (strips `output_config`/`context_management`,
forces `temperature: 1.0`), and `OpenAiStreamUsageStep` injects
`stream_options.include_usage: true` on streaming requests. The `thinking`
field is controlled by `PerModelRuleStep`, not by `reasoning_effort`
stamping. A post-stamp `StripOmoReminderStep` (gated by
`experiment_strip_omo_reminder`) strips oh-my-openagent reminder blocks.

```
                        STAMP PIPELINE (src/stamp-pipeline.ts, 10 steps)
                        ────────────────────────────────────────────────────

  Anthropic request body (stamp_claude_code_enabled = true)
        │
        ▼
┌───────────────────────┐
│ 1. RestampBreakpoints │  restamp-breakpoints.ts (ADR 0002)
│   Layout B: system[0] │  → cache_control breakpoints re-laid before TTL
│   + last user         │
└───────┬───────────────┘
        │
        ▼
┌───────────────────────┐
│ 2. CacheTtl           │  stamp.ts
│   + ttl:"1h" on       │  → cache_control ephemeral blocks
│     ephemeral         │
└───────┬───────────────┘
        │
        ▼
┌───────────────────────┐
│ 3. AnthropicBody      │  stamp-thinking.ts
│   + max_tokens        │  → umans-glm*: 131071, others: 32767
│   + thinking(overlay) │  → { type: "adaptive" } (overlay default)
│   + output_config     │  → { effort: "high"|"max" } from policy
│   - reasoning_effort  │  → stripped if present
└───────┬───────────────┘
        │
        ▼
┌───────────────────────┐
│ 4. PerModelRule       │  stamp-catalog.ts (ADR-0029)
│   overrides thinking  │  → stamp_model_rules: glob pattern, first-match
│   shape per model     │     wins. Independent of master toggles.
│   + openai_extra_body │  → merged at top level of request body
└───────┬───────────────┘
        │
        ▼
┌───────────────────────┐
│ 5. ContextManagement  │  injected when isThinkingEnabled(body.thinking)
│   + clear_thinking    │  → { edits: [{ type: clear_thinking_20251015,
│     keep: "all"       │       keep: "all" }] }
└───────┬───────────────┘
        │
        ▼
┌───────────────────────┐
│ 8. TopK               │  stamp-topk.ts (when thinking enabled)
│   + top_k: 20         │  → injected after model field
└───────┬───────────────┘
        │
        ▼
┌───────────────────────┐
│ 9. Temperature        │  stamp-temperature.ts (when thinking enabled)
│   = 1.0 (forced)      │
└───────┬───────────────┘
        │
        ▼
┌───────────────────────┐
│ 10. StripOmoReminder  │  experiments/strip-omo-reminder.ts
│   (opt-in, default    │  → strips [Category+Skill Reminder] from
│    off)               │     messages[0].content (Anthropic only)
└───────┬───────────────┘
        │
        ▼
  Stamped body ──────────► forwarded upstream AND captured
                          (inspector shows exactly what went to API)


  OpenAI-compatible request body (stamp_reasoning_effort_enabled)
        │
        ▼
┌───────────────────────┐
│ 4. PerModelRule       │  stamp-catalog.ts (ADR-0029)
│   thinking shape      │  → openai_thinking_shape overrides thinking
│   + openai_extra_body │  → merged at top level of request body
│                       │  → openai_veto_reasoning_effort flag set
└───────┬───────────────┘
        │
        ▼
┌───────────────────────┐
│ 6. OpenAiReasoning    │  stamp-reasoning.ts
│   + reasoning_effort  │  → high (default), max (umans-glm*)
│   - output_config     │  → strips output_config + context_management
│   - context_management│  → forces temperature: 1.0
│   = temperature: 1.0  │  → thinking NOT stripped (controlled by step 4)
│   veto? skip inject   │  → openai_veto_reasoning_effort skips injection
└───────┬───────────────┘
        │
        ▼
┌───────────────────────┐
│ 7. OpenAiStreamUsage  │  when stream: true + reasoning active
│   + stream_options    │  → { include_usage: true } if not already set
│     .include_usage    │
└───────┬───────────────┘
        │
        ▼
┌───────────────────────┐
│ 8. TopK               │  stamp-topk.ts (when reasoning_effort present)
│   + top_k: 20         │
└───────────────────────┘
```

### 3. Vision Handoff

```
proxy.ts → vision/handoff.ts → detect images → extract context → triage strategy
  → [transcode → vision model] → cache → replace blocks
```

When `vision_strategy` is `catalog` or `always`, vision handoff runs in six
steps. (Note: `vision_strategy` defaults to `never` while umans.ai's
subscription plan is unavailable — the pipeline below stays in code and
can be reactivated by flipping the default back.)

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

``
Upstream gate (authoritative):
  GET /v1/usage → limits.requests.limit (wallet tier) + usage.requests_in_window
  If requestsInWindow >= requestsHardCap − request_rate_margin → REJECT locally

Local burst fallback (SlidingWindowRateLimiter):
  Short-horizon sliding window between /v1/usage polls
  NOT the authoritative budget; catches bursts between snapshots
```

### Upstream snapshot gate

The **single source of truth** for request budget is the upstream account
snapshot fetched from `GET /v1/usage` at `usage_refresh_ms` intervals.
The proxy compares `usage.requests_in_window` (unweighted, raw count of
all requests in the rolling window) against the effective hard cap and
rejects *before* forwarding upstream when the wallet is about to exceed
its limit:

- **Effective cap** = `requestsHardCap` when `request_use_hard_cap` is
  `true`, or `requestsLimit` when `false`.
- **Gate threshold** = effective cap − `request_rate_margin` (default
  `50`, non-negative integer). E.g. at hardCap 1000 and margin 50,
  requests are blocked at 950 so the wallet never hits the upstream cap.
- **Rejection**: HTTP `503` with `error: "rate_limit_exceeded"` and a
  `Retry-After` header, *before* the request reaches upstream.
- `rate_limit_requests`: `0` auto-derives from `/v1/usage` (default),
  `-1` disables the *local* limiter, `>0` is unused (legacy; prefer the
  upstream gate). This knob does **not** disable the upstream snapshot
  gate.
- `never_limit_requests` (default `true`): disables the *local* burst
  limiter only. The upstream snapshot gate is **independent** — it stays
  active regardless of `rate_limit_requests` / `never_limit_requests` and
  always protects the wallet from exceeding the upstream hard cap.

### Wallet tier

Wallet tier is derived from `limits.requests.limit` returned by
`/v1/usage`. All keys on a wallet (automation keys, wallet-funded cloud
agents) share the same tier. Tier is set by lifetime paid top-ups and
never decreases; bonus credits count toward balance but not tier.

| Tier | Lifetime top-up | Requests per 5-hour window | Max in flight |
|------|-----------------|----------------------------|---------------|
| 0 | First top-up | 500 | 4 |
| 1 | $50 | 1,000 | 8 |
| 2 | $250 | 2,000 | 12 |
| 3 | $1,000 | 4,000 | 16 |

### Local burst limiter

The `SlidingWindowRateLimiter` in `src/rate.ts` remains as a
short-horizon burst fallback between `/v1/usage` polls. It is *not*
the authoritative budget. GateStats exposes both raw and weighted
usage (`weightedRequestsInWindow`, `weightedRemainingRequests`)
for the dashboard.

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
  it). Request body modifications are gated by config flags and default on
  (`stamp_claude_code_enabled` and `stamp_reasoning_effort_enabled` both
  default to `true`)
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
