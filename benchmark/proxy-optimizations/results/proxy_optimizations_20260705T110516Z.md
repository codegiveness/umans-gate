# Proxy Optimization Benchmark Report

**Date:** 2026-07-05 11:05:24 UTC
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
| http_protocol | HTTP/1.1 vs HTTP/2 | median total (ms) | 979.9 | 935.1 | -44.8 | HTTP/2 |
| keepalive | cold vs warm | median total (ms) | 1145.4 | 923.9 | +221.5 | warm (keep-alive) |

## Detailed Results

### http_protocol

**http1.1**:
- TTFB: min=591.7ms, median=979.9ms, max=1368.0ms, mean=979.9ms (±548.9)
- Total: min=591.7ms, median=979.9ms, max=1368.0ms, mean=979.9ms (±548.9)

**http2**:
- TTFB: min=561.3ms, median=935.1ms, max=1309.0ms, mean=935.1ms (±528.7)
- Total: min=561.3ms, median=935.1ms, max=1309.0ms, mean=935.1ms (±528.7)

### keepalive

**cold**:
- TTFB: min=1134.3ms, median=1145.4ms, max=1156.6ms, mean=1145.4ms (±15.8)
- Total: min=1134.3ms, median=1145.4ms, max=1156.6ms, mean=1145.4ms (±15.8)

**warm**:
- TTFB: min=586.7ms, median=923.9ms, max=1261.0ms, mean=923.9ms (±476.8)
- Total: min=586.7ms, median=923.9ms, max=1261.0ms, mean=923.9ms (±476.8)

## Optimization Decisions

| Optimization | Decision | Rationale |
|---|---|---|
| HTTP/2 upstream | 🔬 Consider switching | HTTP/2 is 44.8ms faster |
| Keep-alive (Bun internal pool) | ✅ Already works | warm is 221.5ms faster than cold |
