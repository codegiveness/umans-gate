# Performance Tab Reference

> **Applies to:** umans-gate v0.4.0 · **Last updated:** 2026-07-26

## Tab

- **Name**: Performance
- **Value**: `performance`
- **Lazy**: Yes

## Component

| File | Component |
|---|---|
| dashboard/src/components/performance-meter.tsx | PerformanceMeter |

## Data Source

- `CaptureDB.getPerformanceStats()` — src/db.ts:626
  - Aggregates per-model TTFT, TPS, token throughput
  - Sample window: `performance_sample_count` (default 200)

## REST Endpoints

All prefixed `/dashboard/api/`.

| Method | Path | Purpose |
|---|---|---|
| GET | /performance | Per-model performance stats |

## WebSocket

- Endpoint: `/dashboard/ws`
- Updates piggyback on capture events (`new`, `update`)
- No dedicated performance message type

## Purpose

Per-model latency and throughput statistics:
- TTFT (time to first token)
- TPS (tokens per second)
- Token throughput (input/output)
- Recent sample window, not lifetime totals

## Config

- `performance_sample_count` (default 200) — sample window size

## Related

- Source: src/proxy.ts (TTFT capture), src/db.ts (aggregation)
- TTFT watchdog: `ttft_timeout_ms`, `ttft_retry_*` fields
  (experimental, see `experiment_ttft_watchdog`)
