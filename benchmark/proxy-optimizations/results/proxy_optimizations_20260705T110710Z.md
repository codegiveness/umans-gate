# Proxy Optimization Benchmark Report

**Date:** 2026-07-05 11:07:12 UTC
**API:** `https://api.code.umans.ai/v1`
**API Key:** `sk-f1qgI...tmJI`
**Runs per test:** 1

## Methodology

- Direct upstream API calls (no proxy in path).
- Each test runs N sequential requests, alternating where noted.
- Measures TTFB, total latency, tokens/sec.
- Uses `httpx` with HTTP/2 support for protocol comparison.

## Summary Results

| Test | Comparison | Metric | Value A | Value B | Diff | Winner |
|------|------------|--------|---------|---------|------|--------|
| http_protocol | HTTP/1.1 vs HTTP/2 | median total (ms) | 1214.7 | 1235.2 | +20.5 | HTTP/1.1 |

## Detailed Results

### http_protocol

**http1.1**:
- TTFB: min=1214.7ms, median=1214.7ms, max=1214.7ms, mean=1214.7ms (±0)
- Total: min=1214.7ms, median=1214.7ms, max=1214.7ms, mean=1214.7ms (±0)

**http2**:
- TTFB: min=1235.2ms, median=1235.2ms, max=1235.2ms, mean=1235.2ms (±0)
- Total: min=1235.2ms, median=1235.2ms, max=1235.2ms, mean=1235.2ms (±0)

## Optimization Decisions

| Optimization | Decision | Rationale |
|---|---|---|
| HTTP/1.1 default | ✅ Keep default | HTTP/1.1 is 20.5ms faster than HTTP/2 |
