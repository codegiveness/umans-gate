# Proxy Modifications Inventory

> **Applies to:** umans-gate v0.4.1 · **Last updated:** 2026-07-26

Complete inventory of every modification the proxy applies to
request/response traffic. Grouped by layer: HTTP headers, request body,
and connection/transport.

Each entry lists: **what**, **where** (code), **when** (conditional vs
unconditional), and **config** that gates it.

---

## Layer 1: HTTP Headers

### 1.1 Hop-by-hop header stripping (request)

- **What**: Removes hop-by-hop headers before forwarding upstream. Stripped
  set: `connection`, `keep-alive`, `proxy-authenticate`,
  `proxy-authorization`, `te`, `trailers`, `transfer-encoding`, `upgrade`,
  `content-length`, `host`.
- **Where**: `src/proxy.ts` (forwarded header loop), HOP set in
  `src/shared/http-headers.ts`.
- **When**: Unconditional — every proxied request, all routes.
- **Config**: None (always on).
- **Rationale**: RFC 7230 §6.1. `content-length` stripped because the body
  may be re-serialized after stamping. `host` stripped because Bun's
  `fetch` sets it from the target URL.

### 1.2 `accept-encoding: identity` (request)

- **What**: Forces `accept-encoding: identity` on every upstream request.
- **Where**: `src/proxy.ts`.
- **When**: Unconditional — overwrites any client-supplied value.
- **Config**: None (always on).
- **Rationale**: The proxy decodes response bodies for capture and cannot
  assume gzip/br support. Identity keeps the contract simple.

### 1.3 `content-encoding` strip (response)

- **What**: Strips `content-encoding` from the upstream response headers
  before forwarding to the client.
- **Where**: `src/proxy.ts` (response header filter loop).
- **When**: Unconditional.
- **Config**: None.
- **Rationale**: Safety net — if upstream ignores `identity` and compresses
  anyway, removing the header prevents the client from trying to
  decompress uncompressed bytes.

### 1.4 Hop-by-hop header stripping (response)

- **What**: Same HOP set as 1.1, applied to response headers.
- **Where**: `src/proxy.ts`.
- **When**: Unconditional.
- **Config**: None.

---

## Layer 2: Request Body

### 2.1 Stamp pipeline (Claude Code bundle)

- **What**: Applies the full Claude Code stamp bundle to Anthropic requests
  in order: TTL, `top_k`, `temperature`, `max_tokens`, `thinking`,
  `output_config`, `context_management`.
- **Where**: `src/stamp-pipeline.ts` (orchestrator), called from
  `src/proxy.ts`. Modules: `src/stamp.ts` (TTL), `src/stamp-topk.ts`
  (`top_k`), `src/stamp-temperature.ts` (temperature),
  `src/stamp-thinking.ts` (`max_tokens`, `thinking`, `output_config`),
  `src/stamp-catalog.ts` (per-model `max_tokens`/`effort` via
  `STAMP_OVERLAY`).
- **When**: Anthropic route only (`/v1/messages`), gated by
  `config.stampClaudeCodeEnabled`.
- **Config**: `stamp_claude_code_enabled` JSON (default: `false`) /
  `STAMP_CLAUDE_CODE_ENABLED` env.
- **Stamp values** (when enabled):
  - TTL: `"1h"` on every `cache_control: {type:"ephemeral"}` block
  - `top_k`: `20`
  - `temperature`: `1.0`
  - `max_tokens`: `131071` for `umans-glm*`, `32767` for others
  - `thinking`: `{ "type": "adaptive" }` for `umans-coder`, `umans-flash`,
    `umans-kimi*`, `umans-qwen*`, `umans-glm*`
  - `output_config`: `{ "effort": "high" }` for most; `{ "effort": "max" }`
    for `umans-glm*`
  - `context_management`: `{ "edits": [{ "type": "clear_thinking_20251015", "keep": "all" }] }`
- **Rationale**: Extends the KV cache window (TTL), satisfies model-specific
  requirements, enables adaptive reasoning. Single toggle ensures correct
  order with consistent values.

### 2.2 OpenAI-compatible `reasoning_effort` injection

- **What**: Removes `max_tokens` and `thinking` from the body, then injects
  `"reasoning_effort": "high"` (or `"max"` for `umans-glm*`).
- **Where**: `src/stamp-reasoning.ts`, called from `src/proxy.ts`.
- **When**: OpenAI-compatible route only (`/v1/chat/completions`), gated by
  `config.stampReasoningEffort !== null`.
- **Config**: `stamp_reasoning_effort_enabled` JSON (default: `false`) /
  `STAMP_REASONING_EFFORT_ENABLED` env.
- **Rationale**: The upstream OpenAI endpoint only recognizes
  `reasoning_effort`; forwarding `max_tokens` or `thinking` can cause
  errors.

### 2.3 Body re-serialization

- **What**: When any body modification changes the body, `reqBuf` is
  re-encoded via `JSON.stringify`.
- **Where**: `src/proxy.ts` after each modifier.
- **When**: Only when a modification actually changed the body.
- **Rationale**: The original `content-length` is stripped (1.1); the
  forwarded request has a correct body without a stale length header.

### 2.4 Vision handoff (image → text)

- **What**: Replaces image blocks with text descriptions from a vision model
  (default: `umans-flash`). Images are transcoded, sent to the vision model,
  and the description replaces the image block. Descriptions cached (7-day
  TTL) with persistent SQLite storage.
- **Where**: `processBody` / `processBodyCacheOnly` in
  `src/vision/handoff.ts`, called from `src/proxy.ts`.
- **When**: Both routes, gated by `config.visionStrategy !== "never"`.
  - `always`: intercept all images
  - `catalog`: intercept only if model lacks vision support
  - `never`: disabled
- **Intent-aware prompting**: a deterministic triage function
  (`src/vision/triage.ts`) routes to one of four strategies based on
  adjacent text, image count, and tool-result status:
  - `generic`: plain OCR prompt
  - `slotted`: structured prompt with the user's adjacent question
  - `crafted`: LLM reformulates the question (single-image, Strategy D)
  - `decomposed`: LLM splits a multi-image question into per-image
    sub-questions (DecoVQA+)
  Gated by `vision_intent_strategy` (default `auto`). Failures fall back to
  `slotted`.
- **Config**: `vision_strategy` (default: `catalog`), `vision_model`
  (default: `umans-flash`), `vision_concurrency` (default: `1`),
  `vision_max_images`, `vision_timeout_ms`, `vision_cache_size`,
  `vision_intent_strategy` (default: `auto`),
  `vision_decomposition_enabled` (default: `true`),
  `vision_decomposition_timeout_ms`, `vision_crafting_timeout_ms` (default:
  `3000`), `vision_adjacent_text_max_chars`, `vision_recent_messages_count`,
  `vision_system_prompt_max_chars`.
- **Rationale**: Enables text-only models to "see" images. Text is
  KV-cacheable (image bytes are not), improving cache hit rates.
- **Serialization**: Vision calls serialized by a `ConcurrencyGate` (default
  concurrency=1) because the upstream has limited vision slots.

---

## Layer 3: Connection / Transport

### 3.1 Upstream HTTP protocol

- **What**: Selects HTTP/1.1 or HTTP/2 for upstream `fetch` calls.
- **Where**: `src/proxy.ts` (`protocol` option in fetch),
  `src/config/env.ts` (resolver).
- **When**: Unconditional.
- **Config**: `upstream_protocol` JSON (default: `http1.1`) /
  `UPSTREAM_PROTOCOL` env. Values: `http1.1`, `http2`, `h2` (alias).
- **Rationale**: HTTP/1.1 is faster for the typical 4-concurrent-SSE
  workload. HTTP/2 available as opt-in.

### 3.2 `server.timeout(req, 0)` (incoming)

- **What**: Disables the per-request idle timeout for proxy routes.
- **Where**: `src/index.ts`.
- **When**: Unconditional — every LLM route request.
- **Config**: None.
- **Rationale**: LLM streaming responses (SSE) are long-lived. Bun's
  default idle timeout would kill them mid-stream.

### 3.3 Server `idleTimeout`

- **What**: Sets the global idle timeout for incoming connections.
- **Where**: `src/index.ts`.
- **When**: Unconditional.
- **Config**: `idle_timeout` JSON (default: `255`, max `255`).
- **Rationale**: 255s is the Bun maximum. Dashboard/viewer connections time
  out after 255s idle; proxy streaming connections have no timeout (3.2).

### 3.4 `reusePort: true`

- **What**: Enables `SO_REUSEPORT` on the listening socket.
- **Where**: `src/index.ts`.
- **When**: Unconditional (hardcoded).
- **Config**: None.
- **Rationale**: Allows multiple proxy instances to bind the same port for
  load balancing.

### 3.5 `incomingProtocol: http1.1`

- **What**: Sets the incoming (client→proxy) protocol to HTTP/1.1.
- **Where**: `src/index.ts` (`Bun.serve` options).
- **When**: Unconditional (hardcoded).
- **Config**: None.
- **Rationale**: HTTP/1.1 for incoming is standard. HTTP/2 incoming would
  require h2c or TLS ALPN, adding complexity for no benefit.

### 3.6 AbortSignal forwarding

- **What**: Forwards the client's `AbortSignal` to the upstream `fetch`.
- **Where**: `src/proxy.ts` (`signal: req.signal` in fetch options).
- **When**: Unconditional.
- **Config**: None.
- **Rationale**: If the client disconnects mid-stream, the upstream request
  is aborted immediately, freeing concurrency slots and avoiding wasted
  compute. Propagates to the vision gate (queued vision calls cancelled).

### 3.7 Connection warmer

- **What**: Periodically pings `/v1/models` upstream to keep TLS warm. Skips
  if real traffic occurred recently.
- **Where**: `src/warmer.ts` (`ping()` method).
- **When**: Background interval, gated by `config.warmerEnabled`.
- **Config**: `warmer_enabled` JSON (default: `true`),
  `warmer_interval_ms` (default: `20000`). Warmer path is hardcoded
  (`/v1/models`, not configurable).
- **Rationale**: Prevents TLS handshake overhead (~750ms) on the first
  request after startup or idle.

---

## What the proxy does NOT modify

- **Authorization header**: Passed through unchanged.
- **Content-Length recalculation**: Not set on forwarded request — stripped
  via hop-by-hop (1.1); Bun's `fetch` sets it from the body.
- **SSE response body**: Streamed through unchanged via `TransformStream`.
  No event rewriting, injection, or buffering beyond capture.
- **Keep-alive / connection pool**: Bun manages internally.
- **Transfer-Encoding**: Not modified. Stripped as hop-by-hop on both sides.

---

## TTFT-watchdog gated retry (experimental)

- **What**: Each upstream fetch gets a first-byte watchdog. If no chunk
  arrives within `ttft_timeout_ms` (default 60s), the fetch is aborted and a
  gated retry may follow. Ladder: (1) original with watchdog, (2) same-key
  retry if gated, (3) rewrite-id escalation if eligible. Auto-disables after
  `ttft_retry_failure_threshold` consecutive failures within
  `ttft_retry_failure_window_ms`.
- **Where**: `src/proxy.ts` (retry loop),
  `src/experiments/ttft-watchdog-state.ts` (auto-disable state). See ADR
  0004.
- **When**: Only when `experiment_ttft_watchdog: true` (default: false).
  Streaming (SSE) responses only.
- **Config**: `experiment_ttft_watchdog`, `ttft_timeout_ms`,
  `ttft_retry_max_attempts`, `ttft_retry_gate_saturation_pct`,
  `ttft_retry_failure_window_ms`, `ttft_retry_failure_threshold`,
  `ttft_retry_cooldown_ms`. All hot-reloadable.
- **Response headers** (when feature is on):
  - `X-Proxy-Retry-Attempt: <n>` — 0 = no retry, 1 = same-key, 2 = rewrite
  - `X-Proxy-TTFT-Exceeded: 1` — present when the watchdog fired
  - `X-Proxy-Breaker-State: <closed|half_open|open>` — at response time
- **Rationale**: Detects stuck fetches early (60s, not 5min) and retries
  without doubling load on a degraded upstream. Self-falsifying: auto
  -disables when retries consistently also fail. See ADR 0004.

---

## Optimization decisions

Benchmarked 2026-07-05 against `https://api.code.umans.ai/v1`, 5 runs per
test. Full results in `benchmark/proxy-optimizations/results/`.

| Optimization | Status | Evidence |
|---|---|---|
| HTTP/1.1 default upstream | Kept | 760.1ms vs HTTP/2 760.8ms — noise |
| HTTP/2 upstream option | Available (opt-in) | Configurable via `upstream_protocol: http2`; no win at current concurrency |
| `accept-encoding: identity` | Kept | 852.3ms vs gzip 851.9ms — tied; identity is safer for capture |
| Hop-by-hop stripping | Kept | RFC 7230 compliance |
| TTL stamping (1h) | Kept | Improves multi-turn KV cache hit rates |
| `top_k` injection (20) | Kept | Required by glm-5.2 |
| Vision handoff | Kept | Enables glm-5.2 vision; improves cacheability |
| Vision concurrency gate (1) | Kept | Prevents racing for upstream vision slot |
| Keep-alive reuse | Already works (Bun) | warm 713.4ms vs cold 1192.3ms — 40% saved |
| SSE gzip disable | Already on (identity) | No measurable difference; safer for capture |
| Streaming TTFB | Stream is faster | 663.5ms vs non-stream 763.2ms — 99.7ms faster |
| API path | Anthropic faster | Anthropic 635.0ms vs OpenAI 714.0ms — 79ms diff |
