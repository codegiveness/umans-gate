# Proxy Optimization Benchmark Report

**Date:** 2026-07-05 11:06:14 UTC
**API:** `https://api.code.umans.ai/v1`
**API Key:** `sk-f1qgI...tmJI`
**Runs per test:** N/A

## Methodology

- Direct upstream API calls (no proxy in path).
- Each test runs N sequential requests, alternating where noted.
- Measures TTFB, total latency, tokens/sec.
- Uses `httpx` with HTTP/2 support for protocol comparison.

## Summary Results

| Test | Comparison | Metric | Value A | Value B | Diff | Winner |
|------|------------|--------|---------|---------|------|--------|
| http_protocol | HTTP/1.1 vs HTTP/2 | median total (ms) | 760.1 | 760.8 | +0.7 | HTTP/1.1 |
| keepalive | cold vs warm | median total (ms) | 1192.3 | 713.4 | +478.9 | warm (keep-alive) |
| encoding | identity vs gzip (SSE) | median total (ms) | 852.3 | 851.9 | -0.4 | gzip |
| api_path | OpenAI vs Anthropic | median total (ms) | 714.0 | 635.0 | -79.0 | Anthropic |
| streaming | stream vs non-stream | median TTFB (ms) | 763.2 | 663.5 | -99.7 | stream |

## Detailed Results

### http_protocol

**http1.1**:
- TTFB: min=584.8ms, median=760.1ms, max=1206.7ms, mean=823.4ms (±267.9)
- Total: min=584.8ms, median=760.1ms, max=1206.7ms, mean=823.4ms (±267.9)

**http2**:
- TTFB: min=614.1ms, median=760.8ms, max=1147.8ms, mean=806.9ms (±200.6)
- Total: min=614.1ms, median=760.8ms, max=1147.8ms, mean=806.9ms (±200.6)

### keepalive

**cold**:
- TTFB: min=988.5ms, median=1192.3ms, max=1734.1ms, mean=1305.8ms (±287.8)
- Total: min=988.5ms, median=1192.3ms, max=1734.1ms, mean=1305.8ms (±287.8)

**warm**:
- TTFB: min=549.3ms, median=713.4ms, max=1270.5ms, mean=794.4ms (±277.3)
- Total: min=549.3ms, median=713.4ms, max=1270.5ms, mean=794.4ms (±277.3)

### encoding

**identity**:
- TTFB: min=504.7ms, median=670.2ms, max=2015.6ms, mean=874.6ms (±643.1)
- Total: min=687.2ms, median=852.3ms, max=2030.6ms, mean=1023.8ms (±568.7)

**gzip**:
- TTFB: min=504.5ms, median=665.5ms, max=1085.5ms, mean=711.2ms (±219.8)
- Total: min=830.2ms, median=851.9ms, max=1287.0ms, mean=1017.1ms (±240.4)

### api_path

**openai**:
- TTFB: min=546.1ms, median=714.0ms, max=1122.4ms, mean=762.6ms (±214.0)
- Total: min=546.1ms, median=714.0ms, max=1122.4ms, mean=762.6ms (±214.0)

**anthropic**:
- TTFB: min=555.6ms, median=635.0ms, max=731.8ms, mean=639.0ms (±84.5)
- Total: min=555.6ms, median=635.0ms, max=731.8ms, mean=639.0ms (±84.5)

### streaming

**non_stream**:
- TTFB: min=612.0ms, median=763.2ms, max=1109.3ms, mean=781.5ms (±200.6)
- Total: min=612.0ms, median=763.2ms, max=1109.3ms, mean=781.5ms (±200.6)
- Tokens/sec: median=238096724.9, mean=237562416.5

**stream**:
- TTFB: min=489.9ms, median=663.5ms, max=666.7ms, mean=601.5ms (±87.9)
- Total: min=669.0ms, median=843.2ms, max=1301.6ms, mean=899.5ms (±237.0)

## Optimization Decisions

| Optimization | Decision | Rationale |
|---|---|---|
| HTTP/1.1 default | ✅ Keep default | HTTP/1.1 is 0.7ms faster than HTTP/2 |
| Keep-alive (Bun internal pool) | ✅ Already works | warm is 478.9ms faster than cold |
| gzip on SSE | 🔬 Investigate | gzip is 0.4ms faster — may benefit non-SSE |
