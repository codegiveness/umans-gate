# Benchmarks

> **Applies to:** umans-gate v0.4.8 · **Last updated:** 2026-07-28

Benchmark results for umans-gate proxy optimizations, measured against
`https://api.code.umans.ai/v1`.

## Methodology

- Benchmarked against `https://api.code.umans.ai/v1`.
- 5 runs per test configuration.
- Median values reported to filter outliers.
- Tests run on 2026-07-05.

## Results

| Optimization | Status | Evidence |
|---|---|---|
| HTTP/1.1 default upstream | ✅ Kept | HTTP/1.1 median 760.1ms vs HTTP/2 760.8ms, 0.7ms diff (noise) |
| HTTP/2 upstream option | ✅ Available (opt-in) | Configurable via `upstream_protocol: http2`; no measurable win at current concurrency |
| `accept-encoding: identity` | ✅ Kept | identity 852.3ms vs gzip 851.9ms on SSE, statistically tied; identity is correct for capture safety |
| Hop-by-hop stripping | ✅ Kept | RFC 7230 compliance |
| TTL stamping (1h) | ✅ Kept | Improves multi-turn KV cache hit rates (part of stamp bundle) |
| `top_k` injection (20) | ✅ Kept | Required by glm-5.2 (part of stamp bundle) |
| Vision handoff | ✅ Kept | Enables text-only models to process images; improves cacheability |
| Vision concurrency gate (concurrency=1) | ✅ Kept | Prevents racing for upstream vision slot |
| Keep-alive connection reuse | ✅ Already works (Bun internal) | warm 713.4ms vs cold 1192.3ms, 478.9ms (40%) saved via connection reuse |
| SSE gzip disable | ✅ Already on (identity) | No measurable difference; identity is safer for capture |
| Streaming TTFB | ✅ Stream is faster TTFB | stream 663.5ms vs non-stream 763.2ms, 99.7ms faster first byte |
| API path | ℹ️ Anthropic faster | Anthropic 635.0ms vs OpenAI 714.0ms, 79ms diff (model routing overhead) |

## Key findings

### Why HTTP/1.1 is the default upstream protocol

HTTP/1.1 is the default upstream protocol. Benchmarks show no measurable
difference between HTTP/1.1 and HTTP/2 for the typical 4-concurrent-SSE
workload against `api.code.umans.ai` (uvicorn upstream). HTTP/2 multiplexing
overhead exceeds its benefit at this concurrency level.

### How connection reuse affects latency

Keep-alive connection reuse saves ~479ms (40%) per request. The connection
warmer (`warmer_enabled: true`, interval 20000ms) pings `/v1/models`
periodically to keep TLS warm. The warmer skips pings when real traffic
occurred in the last interval.

### Streaming vs non-streaming first-byte latency

Streaming responses (SSE) deliver the first byte 99.7ms faster than
non-streaming responses. SSE sends the first token as soon as it is generated;
non-streaming waits for the full response.

### Compression impact on SSE responses

Forcing `accept-encoding: identity` (no compression) has no measurable
performance impact on SSE responses. Identity is kept for capture safety: the
proxy reads response bodies for capture, and decompression would add complexity
and risk corrupting streams.

## How to run the benchmarks

Benchmark scripts live in `benchmark/`. Run them to generate fresh results for
regression tracking.

```bash
# Requires a running proxy and UMANS_API_KEY
cd benchmark
bun run <benchmark-script>.ts
```

## Historical results

Benchmark results are summarized in the table above. Raw result files are in
`benchmark/proxy-optimizations/results/`. Run the benchmark scripts to regenerate
for regression tracking.
