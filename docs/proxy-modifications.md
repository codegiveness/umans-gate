# Proxy Modifications Inventory

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

### 2.1 TTL stamping on `cache_control`

- **What**: Adds `"ttl": "<value>"` to every `cache_control` ephemeral block
  in the request body.
- **Where**: `src/stamp.ts:13-33`, called at `src/proxy.ts:84`.
- **When**: Anthropic route only (`/v1/messages`), gated by `config.stampTtl`.
- **Config**:
  - `stamp_cache_ttl` YAML (default: `1h`)
  - `STAMP_CACHE_TTL` env
  - Set to `"0"`, `"false"`, or `"null"` to disable.
- **Rationale**: The upstream UMANS API accepts `ttl` on `cache_control` but
  clients don't set it. Stamping a 1h TTL extends the KV cache window so
  multi-turn conversations benefit from prefix caching across turns.

### 2.2 `top_k` injection

- **What**: Injects `"top_k": <value>` into the request body immediately
  after the `model` field (preserves JSON key ordering).
- **Where**: `src/stamp-topk.ts:26-41`, called at `src/proxy.ts:111`.
- **When**: Both routes (OpenAI + Anthropic), gated by
  `config.stampTopK !== null`.
- **Config**:
  - `stamp_top_k_enabled` YAML (default: `false`)
  - `STAMP_TOP_K_ENABLED` env
  - Set to `"false"` or `"0"` to disable.
- **Rationale**: `umans-glm-5.2` requires `top_k` on every request body.
  Injecting it at the proxy layer means clients don't need to know
  model-specific requirements. Positioned after `model` for consistency.

### 2.3 `max_tokens`, `thinking`, and `output_config` injection

- **What**: Injects three independent Anthropic body fields:
  - `"max_tokens": 32000` (all models)
  - `"thinking": { "type": "adaptive" }`
    (models `"umans-coder"`, `"umans-flash"`, or starting with `"umans-kimi"` / `"umans-qwen"`)
  - `"output_config": { "effort": "high" }` (all models; `"umans-glm*"` gets `"effort": "max"`)
- **Where**: `src/stamp-thinking.ts`, called at `src/proxy.ts` after body parsing.
- **When**: Anthropic route only (`/v1/messages`). Each field is gated by its own
  toggle. Any existing values are overwritten when the corresponding toggle is on.
- **Config**:
  - `stamp_max_tokens_enabled` YAML (default: `false`)
  - `STAMP_MAX_TOKENS_ENABLED` env
  - `stamp_thinking_enabled` YAML (default: `false`)
  - `STAMP_THINKING_ENABLED` env
  - `stamp_output_config_enabled` YAML (default: `false`)
  - `STAMP_OUTPUT_CONFIG_ENABLED` env
  - Set any to `"false"` or `"0"` to disable that field.
- **Rationale**: Umans models require/expect explicit Anthropic-style body
  shaping. Splitting into three toggles lets operators enable `max_tokens` and
  `output_config` globally while keeping the `thinking` block limited to the
  model families that support it. `umans-glm*` models need `effort: "max"`
  instead of the default `"high"`.

### 2.4 OpenAI-compatible `reasoning_effort` injection

- **What**: Removes `max_tokens` and `thinking` from the request body, then
  injects `"reasoning_effort": "high"` (or `"max"` for `umans-glm*` models).
- **Where**: `src/stamp-reasoning.ts`, called at `src/proxy.ts` after body parsing.
- **When**: OpenAI-compatible route only (`/v1/chat/completions`), gated by
  `config.stampReasoningEffort !== null`.
- **Config**:
  - `stamp_reasoning_effort_enabled` YAML (default: `false`)
  - `STAMP_REASONING_EFFORT_ENABLED` env
  - Set to `"false"` or `"0"` to disable.
- **Rationale**: The upstream OpenAI-compatible endpoint only recognizes
  `reasoning_effort`; forwarding `max_tokens` or `thinking` can cause errors.

### 2.5 Body re-serialization

- **What**: When any body modification (2.1, 2.2, 2.3, 2.4) changes the body,
  `reqBuf` is re-encoded via `JSON.stringify`.
- **Where**: `src/proxy.ts` after each modifier.
- **When**: Only when a modification actually changed the body.
- **Rationale**: The original `content-length` is stripped (1.1) and the body
  is re-serialized, so the forwarded request has a correct body without a
  stale length header.

### 2.6 Vision handoff (image → text)

- **What**: Replaces image blocks in the request body with text descriptions
  generated by a separate vision model (default: `umans-flash`). Each image
  is transcoded to JPEG, sent to the vision model, and the description text
  replaces the image block. Descriptions are cached (24h TTL) to avoid
  re-describing the same image.
- **Where**: `src/vision/handoff.ts:172-364` (`processBody`), called at
  `src/proxy.ts:161`.
- **When**: Both routes, gated by `config.visionStrategy !== "never"`.
  - `always`: intercept all images
  - `catalog`: intercept only if model is known to not support vision
  - `never`: disabled
- **Config**:
  - `vision_strategy` YAML (default: `always`)
  - `vision_model` (default: `umans-flash`)
  - `vision_concurrency` (default: `1` — serializes vision calls)
  - `vision_max_images`, `vision_timeout_ms`, `vision_cache_size`, etc.
- **Rationale**: `umans-glm-5.2` does not support vision directly. Converting
  images to text descriptions enables glm-5.2 to "see" images via a vision
  proxy model. Text is also KV-cacheable (image bytes are not), improving
  cache hit rates for multi-turn image conversations.
- **Serialization**: Vision calls are serialized by a `ConcurrencyGate`
  (default concurrency=1) because the upstream has limited vision slots.
  See `src/limiter.ts`.

---

## Layer 3: Connection / Transport

### 3.1 Upstream HTTP protocol

- **What**: Selects HTTP/1.1 or HTTP/2 for upstream `fetch` calls.
- **Where**: `src/proxy.ts:260` (`protocol` option in fetch),
  `src/config.ts:232-236` (resolver).
- **When**: Unconditional — applies to every upstream request.
- **Config**:
  - `upstream_protocol` YAML (default: `http1.1`)
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
  - `idle_timeout` YAML (default: `255`, max: `255` for Bun.serve)
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
  - `warmer_enabled` YAML (default: `true`)
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
| TTL stamping (1h) | ✅ Kept | Improves multi-turn KV cache hit rates |
| `top_k` injection (20) | ✅ Kept | Required by glm-5.2 |
| Vision handoff | ✅ Kept | Enables glm-5.2 vision; improves cacheability |
| Vision concurrency gate (concurrency=1) | ✅ Kept | Prevents racing for upstream vision slot |
| Keep-alive connection reuse | ✅ Already works (Bun internal) | warm 713.4ms vs cold 1192.3ms — 478.9ms (40%) saved via connection reuse |
| SSE gzip disable | ✅ Already on (identity) | No measurable difference; identity is safer for capture |
| Streaming TTFB | ✅ Stream is faster TTFB | stream 663.5ms vs non-stream 763.2ms — 99.7ms faster first byte |
| API path | ℹ️ Anthropic faster | Anthropic 635.0ms vs OpenAI 714.0ms — 79ms diff (model routing overhead) |
