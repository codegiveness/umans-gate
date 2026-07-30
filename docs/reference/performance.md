# Performance Tab Reference

> **Applies to:** umans-gate v0.5.8 · **Last updated:** 2026-07-30

The Performance tab shows per-model latency and throughput statistics from a recent sample window.

## Tab

- **Name**: Performance
- **Value**: `performance`
- **Lazy**: Yes

## Component

| File | Component |
|---|---|
| dashboard/src/components/performance-meter.tsx | PerformanceMeter |

## Data source

- `CaptureDB.getPerformanceStats()` at src/db.ts:626
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

## What the Performance Tab Shows

The Performance tab displays per-model latency and throughput statistics: TTFT (time to first token), TPS (tokens per second), and token throughput (input/output). Stats are computed from a recent sample window, not lifetime totals.

## Config

- `performance_sample_count` (default 200): sample window size

## Related

- Source: src/proxy.ts (TTFT capture), src/db.ts (aggregation)
- TTFT watchdog: `ttft_timeout_ms`, `ttft_retry_*` fields
  (experimental, see `experiment_ttft_watchdog`)
