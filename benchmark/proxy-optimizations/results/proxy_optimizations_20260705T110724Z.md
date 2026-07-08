# Proxy Optimization Benchmark Report

**Date:** 2026-07-05 11:08:07 UTC
**API:** `https://api.code.umans.ai/v1`
**API Key:** `sk-f1qgI...tmJI`
**Runs per test:** 5

## Methodology

- Direct upstream API calls (no proxy in path).
- Each test runs N sequential requests, alternating where noted.
- Measures TTFB, total latency, tokens/sec.
- Uses `httpx` with HTTP/2 support for protocol comparison.

## Summary Results

| Test | Comparison | Metric | Value A | Value B | Diff | Winner |
|------|------------|--------|---------|---------|------|--------|
| http_protocol | HTTP/1.1 vs HTTP/2 | median total (ms) | 709.6 | 563.8 | -145.8 | HTTP/2 |
| keepalive | cold vs warm | median total (ms) | 1172.2 | 739.1 | +433.1 | warm (keep-alive) |
| encoding | identity vs gzip (SSE) | median total (ms) | 833.8 | 849.7 | +15.9 | identity |
| api_path | OpenAI vs Anthropic | median total (ms) | 743.2 | 564.0 | -179.2 | Anthropic |
| streaming | stream vs non-stream | median TTFB (ms) | 1189.7 | 675.1 | -514.6 | stream |

## Detailed Results

### http_protocol

**http1.1**:
- TTFB: min=554.0ms, median=709.6ms, max=1121.9ms, mean=732.5ms (±231.5)
- Total: min=554.0ms, median=709.6ms, max=1121.9ms, mean=732.5ms (±231.5)

**http2**:
- TTFB: min=553.8ms, median=563.8ms, max=1325.2ms, mean=714.0ms (±341.7)
- Total: min=553.8ms, median=563.8ms, max=1325.2ms, mean=714.0ms (±341.7)

### keepalive

**cold**:
- TTFB: min=1122.7ms, median=1172.2ms, max=1326.6ms, mean=1210.2ms (±94.1)
- Total: min=1122.7ms, median=1172.2ms, max=1326.6ms, mean=1210.2ms (±94.1)

**warm**:
- TTFB: min=560.2ms, median=739.0ms, max=1154.6ms, mean=753.2ms (±240.8)
- Total: min=560.2ms, median=739.1ms, max=1154.6ms, mean=753.2ms (±240.8)

### encoding

**identity**:
- TTFB: min=493.7ms, median=657.9ms, max=1064.7ms, mean=706.0ms (±212.7)
- Total: min=668.7ms, median=833.8ms, max=1235.8ms, mean=880.8ms (±210.9)

**gzip**:
- TTFB: min=500.5ms, median=668.8ms, max=1099.6ms, mean=689.0ms (±244.8)
- Total: min=682.7ms, median=849.7ms, max=1292.8ms, mean=873.1ms (±249.5)

### api_path

**openai**:
- TTFB: min=556.0ms, median=743.2ms, max=1125.5ms, mean=850.0ms (±255.0)
- Total: min=556.0ms, median=743.2ms, max=1125.5ms, mean=850.0ms (±255.0)

**anthropic**:
- TTFB: min=556.0ms, median=564.0ms, max=874.6ms, mean=654.9ms (±142.1)
- Total: min=556.0ms, median=564.0ms, max=874.6ms, mean=654.9ms (±142.1)

### streaming

**non_stream**:
- TTFB: min=612.6ms, median=1189.7ms, max=1505.6ms, mean=1061.6ms (±407.2)
- Total: min=612.6ms, median=1189.7ms, max=1505.6ms, mean=1061.6ms (±407.2)
- Tokens/sec: median=294125478.2, mean=265869337.4

**stream**:
- TTFB: min=501.2ms, median=675.1ms, max=1104.0ms, mean=724.9ms (±252.3)
- Total: min=683.2ms, median=854.6ms, max=1283.4ms, mean=906.3ms (±250.9)

## Optimization Decisions

| Optimization | Decision | Rationale |
|---|---|---|
| HTTP/2 upstream | 🔬 Consider switching | HTTP/2 is 145.8ms faster |
| Keep-alive (Bun internal pool) | ✅ Already works | warm is 433.1ms faster than cold |
| accept-encoding: identity | ✅ Keep (correct default) | identity is 15.9ms faster/equal on SSE |
