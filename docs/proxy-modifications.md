# Proxy Modifications Inventory

> **Applies to:** umans-gate v0.1.4 · **Last updated:** 2026-07-14

Complete inventory of every modification the umans-gate proxy applies to
request/response traffic. Grouped by layer: HTTP headers, request body, and
connection/transport.

Each entry lists: **what** it does, **where** in the code, **when** it applies
(conditional vs unconditional), and the **config** that gates it.

---

## Layer 1: HTTP Headers

### 1.1 Hop-by-hop header stripping (request)

- **What**: Removes hop-by-hop headers before forwarding upstream.
  Stripped set: `connection`, `keep-alive`, `proxy-authenticate`,
  `proxy-authorization`, `te`, `trailers`, `transfer-encoding`, `upgrade`,
  `content-length`, `host`.
- **Where**: `src/proxy.ts:193-197` (forwarded header loop), HOP set defined
  in `src/helpers.ts:13-24`.
- **When**: Unconditional — applies to every proxied request, all routes.
- **Config**: None (always on).
- **Rationale**: RFC 7230 §6.1 mandates hop-by-hop headers be stripped by
  proxies. `content-length` is stripped because the body may be re-serialized
  after TTL/top_k stamping, invalidating the original length. `host` is stripped
  because Bun's `fetch` sets it from the target URL.

### 1.2 `accept-encoding: identity` (request)

- **What**: Forces `accept-encoding: identity` on every upstream request.
- **Where**: `src/proxy.ts:202`.
- **When**: Unconditional — overwrites any client-supplied `accept-encoding`.
- **Config**: None (always on).
- **Rationale**: The proxy decodes response bodies for capture (see 1.3) and
  cannot assume gzip/br support. Advertising compression would require a
  decompression layer that risks corrupting SSE streams. Identity keeps the
  contract simple: what the proxy reads is what the client gets.

### 1.3 `content-encoding` strip (response)

- **What**: Strips `content-encoding` from the upstream response headers
  before forwarding to the client.
- **Where**: `src/proxy.ts:297` (inside the response header filter loop).
- **When**: Unconditional.
- **Config**: None (always on).
- **Rationale**: Because we force `accept-encoding: identity` upstream (1.2),
  the response should already be uncompressed. Stripping `content-encoding`
  is a safety net — if the upstream ignores `identity` and compresses anyway,
  we remove the header so the client doesn't try to decompress uncompressed
  bytes.

### 1.4 Hop-by-hop header stripping (response)

- **What**: Same HOP set as 1.1, applied to response headers.
- **Where**: `src/proxy.ts:296-298`.
- **When**: Unconditional.
- **Config**: None.

---

## Layer 2: Request Body

### 2.1 Stamp pipeline (Claude Code bundle)

- **What**: Applies the full Claude Code stamp bundle to Anthropic requests
  in a defined order: TTL, `top_k`, `temperature`, `max_tokens`, `thinking`,
  `output_config`, and `context_management`.
- **Where**: `src/stamp-pipeline.ts` (orchestrator), called from `src/proxy.ts`.
  Individual stamp modules:
  - `src/stamp.ts` — TTL stamping on `cache_control` ephemeral blocks
  - `src/stamp-topk.ts` — `top_k` injection after `model` field
  - `src/stamp-temperature.ts` — forces `temperature: 1.0`
  - `src/stamp-thinking.ts` — `max_tokens`, `thinking`, `output_config`
  - `src/config.ts` — stamp value constants (`STAMP_CACHE_TTL_VALUE`,
    `STAMP_TOP_K_VALUE`, `STAMP_TEMPERATURE_VALUE`, `STAMP_THINKING_VALUE`,
    `STAMP_MAX_TOKENS_VALUE`, `STAMP_MAX_TOKENS_GLM_VALUE`,
    `STAMP_OUTPUT_CONFIG_VALUE`, `STAMP_OUTPUT_CONFIG_GLM_VALUE`,
    `STAMP_CONTEXT_MANAGEMENT_VALUE`)
- **When**: Anthropic route only (`/v1/messages`), gated by
  `config.stampClaudeCodeEnabled`.
- **Config**:
  - `stamp_claude_code_enabled` JSON (default: `false`)
  - `STAMP_CLAUDE_CODE_ENABLED` env
  - Set to `"false"` or `"0"` to disable.
- **Stamp values** (all applied when enabled):
  - TTL: `"1h"` on every `cache_control: {type:"ephemeral"}` block
  - `top_k`: `20`
  - `temperature`: `1.0`
  - `max_tokens`: `131071` for `umans-glm*` models, `32767` for others
  - `thinking`: `{ "type": "adaptive" }` for `umans-coder`, `umans-flash`,
    `umans-kimi*`, `umans-qwen*`
  - `output_config`: `{ "effort": "high" }` for most models; `{ "effort": "max" }`
    for `umans-glm*`
  - `context_management`: `{ "edits": [{ "type": "clear_thinking_20251015", "keep": "all" }] }`
- **Rationale**: The upstream UMANS API accepts these body fields but clients
  don't always set them. The bundle extends the KV cache window (TTL), satisfies
  model-specific requirements (`top_k`, `max_tokens`), and enables adaptive
  reasoning (`thinking`, `output_config`). Consolidating into a single toggle
  ensures stamps are applied in the correct order with consistent values.

### 2.2 OpenAI-compatible `reasoning_effort` injection

- **What**: Removes `max_tokens` and `thinking` from the request body, then
  injects `"reasoning_effort": "high"` (or `"max"` for `umans-glm*` models).
- **Where**: `src/stamp-reasoning.ts`, called from `src/proxy.ts` after body parsing.
- **When**: OpenAI-compatible route only (`/v1/chat/completions`), gated by
  `config.stampReasoningEffort !== null`.
- **Config**:
  - `stamp_reasoning_effort_enabled` JSON (default: `false`)
  - `STAMP_REASONING_EFFORT_ENABLED` env
  - Set to `"false"` or `"0"` to disable.
- **Rationale**: The upstream OpenAI-compatible endpoint only recognizes
  `reasoning_effort`; forwarding `max_tokens` or `thinking` can cause errors.

### 2.3 Body re-serialization

- **What**: When any body modification (2.1, 2.2) changes the body,
  `reqBuf` is re-encoded via `JSON.stringify`.
- **Where**: `src/proxy.ts` after each modifier.
- **When**: Only when a modification actually changed the body.
- **Rationale**: The original `content-length` is stripped (1.1) and the body
  is re-serialized, so the forwarded request has a correct body without a
  stale length header.

### 2.4 Vision handoff (image → text)

- **What**: Replaces image blocks in the request body with text descriptions
  generated by a separate vision model (default: `umans-flash`). Each image
  is transcoded to the configured format (PNG/JPEG), sent to the vision model,
  and the description text
  replaces the image block. Descriptions are cached (7-day TTL) to avoid
  re-describing the same image.
- **Where**: the `processBody` method in `src/vision/handoff.ts`, called at
  `src/proxy.ts:161`.
- **When**: Both routes, gated by `config.visionStrategy !== "never"`.
  - `always`: intercept all images
  - `catalog`: intercept only if model is known to not support vision
  - `never`: disabled
- **Intent-aware prompting**: once interception is decided, a deterministic triage
  function (`src/vision/triage.ts`) routes the request to one of four strategies
  based on adjacent user text, image count, and tool-result status:
  - `generic`: plain OCR prompt (the original behavior)
  - `slotted`: structured prompt including the user's adjacent question
  - `crafted`: an LLM call reformulates the question into a neutral, focused
    image-description request (single-image, Strategy D)
  - `decomposed`: an LLM call splits a multi-image question into per-image
    sub-questions (DecoVQA+ pattern)
  Gated by `vision_intent_strategy` (default `auto` — triage decides per-request).
  Crafting and decomposition results are cached in-memory; any failure falls back
  to the `slotted` strategy.
- **Config**:
  - `vision_strategy` JSON (default: `catalog`)
  - `vision_model` (default: `umans-flash`)
  - `vision_concurrency` (default: `1` — serializes vision calls)
  - `vision_max_images`, `vision_timeout_ms`, `vision_cache_size`, etc.
  - `vision_intent_strategy` (default: `auto`)
  - `vision_decomposition_enabled` (default: `true`)
  - `vision_decomposition_timeout_ms`, `vision_crafting_timeout_ms` (default: `3000`)
  - `vision_adjacent_text_max_chars`, `vision_recent_messages_count`,
    `vision_system_prompt_max_chars` (context extraction bounds)
- **Rationale**: Some models (e.g. `umans-glm-5.2`) do not support vision
  directly. Converting images to text descriptions enables them to "see" images
  via a vision proxy model. Text is also KV-cacheable (image bytes are not),
  improving cache hit rates for multi-turn image conversations.
- **Serialization**: Vision calls are serialized by a `ConcurrencyGate`
  (default concurrency=1) because the upstream has limited vision slots.
  See `src/limiter/`.

---

## Layer 3: Connection / Transport

### 3.1 Upstream HTTP protocol

- **What**: Selects HTTP/1.1 or HTTP/2 for upstream `fetch` calls.
- **Where**: `src/proxy.ts:260` (`protocol` option in fetch),
  `src/config.ts:232-236` (resolver).
- **When**: Unconditional — applies to every upstream request.
- **Config**:
  - `upstream_protocol` JSON (default: `http1.1`)
  - `UPSTREAM_PROTOCOL` env
  - Values: `http1.1`, `http2`, `h2` (alias)
- **Rationale**: HTTP/1.1 is the default because benchmarks show it's faster
  for the typical 4-concurrent-SSE workload against api.code.umans.ai (uvicorn
  upstream). HTTP/2 multiplexing overhead exceeds its benefit at this
  concurrency level. HTTP/2 is available as an opt-in for future testing.

### 3.2 `server.timeout(req, 0)` (incoming)

- **What**: Disables the per-request idle timeout for proxy routes.
- **Where**: `src/index.ts:205`.
- **When**: Unconditional — applied to every request that matches an LLM route.
- **Config**: None.
- **Rationale**: LLM streaming responses (SSE) can be long-lived. Bun's
  default idle timeout would kill the connection mid-stream. Setting `0`
  removes the timeout for the duration of that specific request.

### 3.3 Server `idleTimeout`

- **What**: Sets the global idle timeout for incoming connections.
- **Where**: `src/index.ts:179`.
- **When**: Unconditional.
- **Config**:
  - `idle_timeout` JSON (default: `255`, max: `255` for Bun.serve)
- **Rationale**: 255s is the Bun maximum. Combined with 3.2 (per-request
  timeout=0 for proxy routes), this means dashboard/viewer connections time
  out after 255s idle, but proxy streaming connections have no timeout.

### 3.4 `reusePort: true`

- **What**: Enables `SO_REUSEPORT` on the listening socket.
- **Where**: `src/index.ts:178`.
- **When**: Unconditional (hardcoded).
- **Config**: None.
- **Rationale**: Allows multiple proxy instances to bind the same port for
  load balancing across processes. Standard for production deployments.

### 3.5 `incomingProtocol: http1.1`

- **What**: Sets the incoming (client→proxy) protocol to HTTP/1.1.
- **Where**: `src/config.ts:401`, used in `src/index.ts:175`.
- **When**: Unconditional (hardcoded).
- **Config**: None.
- **Rationale**: HTTP/1.1 for incoming is standard for LLM API proxies.
  Clients (curl, httpx, SDKs) expect HTTP/1.1. HTTP/2 incoming would require
  h2c or TLS ALPN negotiation, adding complexity for no benefit at this layer.

### 3.6 AbortSignal forwarding

- **What**: Forwards the client's `AbortSignal` to the upstream `fetch`.
- **Where**: `src/proxy.ts:261` (`signal: req.signal` in fetch options).
- **When**: Unconditional.
- **Config**: None.
- **Rationale**: If the client disconnects mid-stream, the upstream request
  is aborted immediately rather than running to completion. This frees
  upstream concurrency slots faster and avoids wasting compute. The abort
  also propagates to the vision concurrency gate (queued vision calls are
  cancelled).

### 3.7 Connection warmer

- **What**: Periodically pings `/v1/models` on the upstream to keep the TLS
  connection warm. Skips the ping if real traffic occurred in the last
  interval.
- **Where**: `src/warmer.ts:45-61`.
- **When**: Background interval, gated by `config.warmerEnabled`.
- **Config**:
  - `warmer_enabled` JSON (default: `true`)
  - `warmer_interval_ms` (default: `20000`)
  - `warmer_path` (default: `/v1/models`)
- **Rationale**: Prevents TLS handshake overhead (~750ms) on the first
  request after startup or extended idle. The ping uses
  `accept-encoding: identity` and the configured upstream protocol.

---

## What the proxy does NOT modify

For completeness, these are explicitly NOT touched:

- **Authorization header**: Passed through unchanged. The proxy does not add,
  remove, or rewrite auth tokens.
- **Content-Length recalculation**: Not set on the forwarded request —
  stripped via hop-by-hop (1.1) and Bun's `fetch` sets it from the body.
- **SSE response body**: Streamed through unchanged via `TransformStream`.
  No event rewriting, no injection, no buffering beyond capture.
- **Keep-alive / connection pool**: Bun manages internally. No custom pool
  configuration. (See "Optimization decisions" below for benchmark results.)
- **Transfer-Encoding**: Not modified. Stripped as hop-by-hop on both sides.

---

## Optimization decisions

This section documents which optimizations were benchmarked and whether
they were kept, based on measured results against
`https://api.code.umans.ai/v1`.

Benchmarked on 2026-07-05 against `https://api.code.umans.ai/v1` with
5 runs per test. Full results in `benchmark/proxy-optimizations/results/`.

| Optimization | Status | Evidence |
|---|---|---|
| HTTP/1.1 default upstream | ✅ Kept | HTTP/1.1 median 760.1ms vs HTTP/2 760.8ms — 0.7ms diff (noise) |
| HTTP/2 upstream option | ✅ Available (opt-in) | Configurable via `upstream_protocol: http2`; no measurable win at current concurrency |
| `accept-encoding: identity` | ✅ Kept | identity 852.3ms vs gzip 851.9ms on SSE — statistically tied; identity is correct for capture safety |
| Hop-by-hop stripping | ✅ Kept | RFC 7230 compliance |
| TTL stamping (1h) | ✅ Kept | Improves multi-turn KV cache hit rates (part of stamp bundle) |
| `top_k` injection (20) | ✅ Kept | Required by glm-5.2 (part of stamp bundle) |
| Vision handoff | ✅ Kept | Enables glm-5.2 vision; improves cacheability |
| Vision concurrency gate (concurrency=1) | ✅ Kept | Prevents racing for upstream vision slot |
| Keep-alive connection reuse | ✅ Already works (Bun internal) | warm 713.4ms vs cold 1192.3ms — 478.9ms (40%) saved via connection reuse |
| SSE gzip disable | ✅ Already on (identity) | No measurable difference; identity is safer for capture |
| Streaming TTFB | ✅ Stream is faster TTFB | stream 663.5ms vs non-stream 763.2ms — 99.7ms faster first byte |
| API path | ℹ️ Anthropic faster | Anthropic 635.0ms vs OpenAI 714.0ms — 79ms diff (model routing overhead) |
