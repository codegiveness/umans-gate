# Proxy modifications inventory

> **Applies to:** umans-gate v0.6.1 · **Last updated:** 2026-07-31

This document lists every modification the proxy applies to
request/response traffic, grouped by layer: HTTP headers, request body,
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
- **When**: Unconditional, every proxied request, all routes.
- **Config**: None (always on).
- **Rationale**: RFC 7230 §6.1. `content-length` is stripped because the body
  may be re-serialized after stamping. `host` is stripped because Bun's
  `fetch` sets it from the target URL.

### 1.2 `accept-encoding: identity` (request)

- **What**: Forces `accept-encoding: identity` on every upstream request.
- **Where**: `src/proxy.ts`.
- **When**: Unconditional, overwrites any client-supplied value.
- **Config**: None (always on).
- **Rationale**: The proxy decodes response bodies for capture and cannot
  assume gzip or brotli support. Identity keeps the contract simple.

### 1.3 `content-encoding` strip (response)

- **What**: Strips `content-encoding` from the upstream response headers
  before forwarding to the client.
- **Where**: `src/proxy.ts` (response header filter loop).
- **When**: Unconditional.
- **Config**: None.
- **Rationale**: Safety net. If upstream ignores `identity` and compresses
  anyway, removing the header prevents the client from trying to
  decompress uncompressed bytes.

### 1.4 Hop-by-hop header stripping (response)

- **What**: Removes the same HOP set as 1.1 from response headers.
- **Where**: `src/proxy.ts`.
- **When**: Unconditional.
- **Config**: None.

---

## What does the proxy modify in the request body?

### 2.1 Stamp pipeline (Claude Code bundle)

- **What**: Applies the full Claude Code stamp bundle to Anthropic requests
  in order: RestampBreakpoints, TTL, AnthropicBody (max_tokens, thinking,
  output_config), PerModelRule, context_management, top_k, temperature.
  See [ARCHITECTURE.md](ARCHITECTURE.md) for the full 10-step pipeline.
- **Where**: `src/stamp-pipeline.ts` (orchestrator), called from
  `src/proxy.ts`. Modules: `src/restamp-breakpoints.ts` (Layout B),
  `src/stamp.ts` (TTL), `src/stamp-thinking.ts` (max_tokens, thinking,
  output_config), `src/stamp-catalog.ts` (per-model `max_tokens`/`effort`
  via `STAMP_OVERLAY` + `stamp_model_rules`), `src/stamp-topk.ts` (top_k),
  `src/stamp-temperature.ts` (temperature).
- **When**: Anthropic route only (`/v1/messages`), gated by
  `config.stampClaudeCodeEnabled`.
- **Config**: `stamp_claude_code_enabled` JSON (default: `false`) /
  `STAMP_CLAUDE_CODE_ENABLED` env.
- **Stamp values** (when enabled):
  - RestampBreakpoints: Layout B (system[0] + last user message), ADR 0002
  - TTL: `"1h"` on every `cache_control: {type:"ephemeral"}` block
  - `max_tokens`: `131071` for `umans-glm*`, `32767` for others
  - `thinking`: `{ "type": "adaptive" }` (overlay default); per-model
    shapes via `stamp_model_rules` (see §2.5)
  - `output_config`: `{ "effort": "high" }` for most; `{ "effort": "max" }`
    for `umans-glm*`
  - `context_management`: `{ "edits": [{ "type": "clear_thinking_20251015", "keep": "all" }] }`
  - `top_k`: `20`
  - `temperature`: `1.0` (forced when thinking enabled)
- **Rationale**: Extends the KV cache window (TTL), satisfies model-specific
  requirements, enables adaptive reasoning. Single toggle ensures correct
  order with consistent values. Per-model rules (ADR-0029) override the
  adaptive thinking shape per family without touching the master toggle.

### 2.2 OpenAI-compatible `reasoning_effort` injection

- **What**: Injects `"reasoning_effort": "high"` (or `"max"` for
  `umans-glm*`), strips `output_config` and `context_management`, and
  forces `temperature: 1.0`. The `thinking` field is **not** stripped —
  it is controlled by `PerModelRuleStep` via `openai_thinking_shape`
  (ADR-0029). When `openai_veto_reasoning_effort` is set on a matching
  per-model rule, `reasoning_effort` injection is skipped but the
  Anthropic-field strip + temperature force still run.
- **Where**: `src/stamp-reasoning.ts`, called from `src/proxy.ts` via
  `src/stamp-pipeline.ts` (`OpenAiReasoningStep`).
- **When**: OpenAI-compatible route only (`/v1/chat/completions`), gated by
  `config.stampReasoningEffort !== null`.
- **Config**: `stamp_reasoning_effort_enabled` JSON (default: `false`) /
  `STAMP_REASONING_EFFORT_ENABLED` env. Per-model veto via
  `stamp_model_rules[].openai_veto_reasoning_effort` (ADR-0029).
- **Rationale**: The upstream OpenAI endpoint recognizes `reasoning_effort`
  but rejects `output_config`/`context_management` (Anthropic-specific) and
  `temperature != 1.0` when reasoning is active. Stripping those prevents
  errors. The `thinking` field is left to per-model rules because some
  OpenAI models accept a thinking shape (e.g. Kimi, Qwen via top-level
  body fields) while others reject it.

### 2.3 Body re-serialization

- **What**: Re-encodes the modified body via `JSON.stringify` when any
  body modifier changes it.
- **Where**: `src/proxy.ts` after each modifier.
- **When**: Only when a modification actually changed the body.
- **Rationale**: The original `content-length` is stripped (1.1); the
  forwarded request has a correct body without a stale length header.

### 2.4 Vision handoff (image → text)

- **What**: Replaces image blocks with text descriptions from a vision model
  (default: `umans-flash`). Images are transcoded, sent to the vision model,
  and the description replaces the image block. Descriptions are cached for
  7 days in persistent SQLite storage.
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
- **Rationale**: Enables text-only models to process image-bearing requests.
  Text is KV-cacheable; image bytes are not.
- **Serialization**: Vision calls are serialized by a `ConcurrencyGate`
  (default concurrency = 1) because the upstream has limited vision slots.

### 2.5 Per-model rule overrides (ADR-0029)

- **What**: Overrides the thinking shape per model family on both Anthropic
  and OpenAI routes, merges `openai_extra_body` keys at the top level of
  the request body, and sets an `openai_veto_reasoning_effort` flag
  consumed by `OpenAiReasoningStep`. Rules match model names by glob
  pattern, first-match-wins.
- **Where**: `src/stamp-pipeline.ts` (`PerModelRuleStep`), resolves via
  `src/stamp-catalog.ts` (`resolvePerModelRule`).
- **When**: Both routes, whenever `stamp_model_rules` is non-empty AND a
  rule matches the request model. **Independent of**
  `stamp_claude_code_enabled` and `stamp_reasoning_effort_enabled` — a
  rule fires whenever a matching model is detected, regardless of whether
  the master toggles are on.
- **Config**: `stamp_model_rules` JSON (default: `[]`, hot-reloadable). Each
  rule: `pattern` (glob), `anthropic_thinking_shape`, `openai_thinking_shape`,
  `openai_extra_body`, `openai_veto_reasoning_effort`.
- **Rationale**: Replaces vendor-specific config flags (ADR-0019) with a
  config-driven table. Adding a new model family is a `config.json` edit,
  not a code change. See
  [ADR-0029](adr/0029-per-model-stamp-rules-table.md) for the full spec
  and target table.

### 2.6 OpenAI stream usage injection

- **What**: Injects `stream_options: { include_usage: true }` on
  streaming OpenAI-compatible requests when `reasoning_effort` stamping is
  active and the body does not already set `include_usage: true`.
- **Where**: `src/stamp-pipeline.ts` (`OpenAiStreamUsageStep`).
- **When**: OpenAI-compatible route only, when `body.stream === true` and
  `config.stampReasoningEffort !== null` and
  `body.stream_options.include_usage !== true`.
- **Config**: Gated by `stamp_reasoning_effort_enabled` (same as
  `OpenAiReasoningStep`).
- **Rationale**: Reasoning models report token usage in the final stream
  chunk only when `include_usage: true`. Without it, the proxy cannot
  capture accurate token counts for economics and usage tracking.

---

## What does the proxy modify in connection / transport?

### 3.1 Upstream HTTP protocol

- **What**: Selects HTTP/1.1 or HTTP/2 for upstream `fetch` calls.
- **Where**: `src/proxy.ts` (`protocol` option in fetch),
  `src/config/env.ts` (resolver).
- **When**: Unconditional.
- **Config**: `upstream_protocol` JSON (default: `http1.1`) /
  `UPSTREAM_PROTOCOL` env. Values: `http1.1`, `http2`, `h2` (alias).
- **Rationale**: HTTP/1.1 is faster for the typical 4-concurrent-SSE
  workload. HTTP/2 is available as opt-in.

### 3.2 `server.timeout(req, 0)` (incoming)

- **What**: Disables the per-request idle timeout for proxy routes.
- **Where**: `src/index.ts`.
- **When**: Unconditional, every LLM route request.
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

## What does the proxy leave unchanged?

- **Authorization header**: Passed through unchanged.
- **Content-Length recalculation**: Not set on forwarded request. Stripped
  via hop-by-hop (1.1); Bun's `fetch` sets it from the body.
- **SSE response body**: Streamed through unchanged via `TransformStream`.
  No event rewriting, injection, or buffering beyond capture.
- **Keep-alive / connection pool**: Bun manages internally.
- **Transfer-Encoding**: Not modified. Stripped as hop-by-hop on both sides.

---

## What is the TTFT-watchdog gated retry (experimental)?

- **What**: Each upstream fetch gets a first-byte watchdog with a dynamic
  two-tier threshold. Attempt 1 uses `min(p50 × ttft_watchdog_multiplier,
  ttft_watchdog_hard_cap_ms)` where p50 is the model's real-time median
  TTFT fetched in parallel from `/v1/status`; `ttft_timeout_ms` (default
  60s) is the fallback before the status response arrives. If no chunk
  arrives within the threshold, the fetch is aborted and a gated retry may
  follow. Retry ladder: (1) original with watchdog, (2) same-key retry if
  gated, (3) rewrite-id escalation if eligible.
- **Where**: `src/proxy.ts` (retry loop), `src/status-client.ts` (p50
  fetch), `src/experiments/ttft-watchdog-state.ts` (state). See ADR-0026
  (supersedes ADR-0004).
- **When**: Only when `experiment_ttft_watchdog: true` (default: true).
  Streaming (SSE) responses only.
- **Config** (all hot-reloadable): `experiment_ttft_watchdog` (default:
  false), `ttft_timeout_ms` (60000), `ttft_watchdog_multiplier` (5),
  `ttft_watchdog_hard_cap_ms` (300000), `ttft_retry_max_attempts` (3),
  `ttft_retry_gate_saturation_pct` (80), `ttft_retry_cooldown_ms` (5000).
- **Response headers** (when feature is on):
  - `X-Proxy-Retry-Attempt: <n>`: 0 = no retry, 1 = same-key, 2 = rewrite
  - `X-Proxy-TTFT-Exceeded: 1`: present when the watchdog fired
  - `X-Proxy-Breaker-State: <closed|half_open|open>`: at response time
- **Rationale**: Detects stuck fetches early and retries without doubling
  load on a degraded upstream. The dynamic threshold adapts per-model: a
  fast model with p50 TTFT of 2s triggers at ~10s (2s × 5), not 60s; a
  slow model with p50 of 8s triggers at ~40s, not 60s. See ADR-0026.

---

## What optimization decisions were made?

Benchmarked 2026-07-05 against `https://api.code.umans.ai/v1`, 5 runs per
test. Full results in `benchmark/proxy-optimizations/results/`.

| Optimization | Status | Evidence |
|---|---|---|
| HTTP/1.1 default upstream | Kept | 760.1ms vs HTTP/2 760.8ms, noise |
| HTTP/2 upstream option | Available (opt-in) | Configurable via `upstream_protocol: http2`; no win at current concurrency |
| `accept-encoding: identity` | Kept | 852.3ms vs gzip 851.9ms, tied; identity is safer for capture |
| Hop-by-hop stripping | Kept | RFC 7230 compliance |
| TTL stamping (1h) | Kept | Improves multi-turn KV cache hit rates |
| `top_k` injection (20) | Kept | Required by glm-5.2 |
| Vision handoff | Kept | Enables glm-5.2 vision; improves cacheability |
| Vision concurrency gate (1) | Kept | Prevents racing for upstream vision slot |
| Keep-alive reuse | Already works (Bun) | warm 713.4ms vs cold 1192.3ms, 40% saved |
| SSE gzip disable | Already on (identity) | No measurable difference; safer for capture |
| Streaming TTFB | Stream is faster | 663.5ms vs non-stream 763.2ms, 99.7ms faster |
| API path | Anthropic faster | Anthropic 635.0ms vs OpenAI 714.0ms, 79ms diff |
