# Usage Tab Reference

> **Applies to:** umans-gate v0.5.9 · **Last updated:** 2026-07-30

The Usage tab visualizes raw `/v1/usage` samples polled from the upstream API.

## Tab

- **Name**: Usage
- **Value**: `usage`
- **Lazy**: Yes

## Components

| File | Component |
|---|---|
| dashboard/src/components/usage-tab.tsx | UsageTab |
| dashboard/src/components/usage-heatmap.tsx | UsageHeatmap |
| dashboard/src/components/usage-timeline.tsx | UsageTimeline |
| dashboard/src/components/usage-timeline-old.tsx | UsageTimelineOld |

## Data source

- `UmansUsageClient` (src/usage.ts)
  - Polls upstream `/v1/usage` on `usage_refresh_ms` (default 60000)
- `UsageHistoryStore` (src/usage-history/)
  - Raw samples + daily aggregates
  - Downsamples raw → daily after `usage_raw_retention_days` (default 7)

## REST Endpoints

All prefixed `/dashboard/api/`.

| Method | Path | Purpose |
|---|---|---|
| GET | /usage | Usage snapshot from /v1/usage |
| GET | /usage/samples | Raw usage samples for a date |
| GET | /usage/events | Usage events for a date |
| GET | /usage/daily | Daily aggregated usage (default 30d) |
| POST | /usage/refresh-source | Refresh limits from /v1/usage |
| POST | /usage/downsample | Force downsample raw → daily |

## WebSocket

- Endpoint: `/dashboard/ws`
- Messages:
  - `usage-sample`: new sample fetched (dayUtc, fetchedAt)
  - `usage-event`: usage event (limit change, reset)

## What the Usage Tab Shows

The Usage tab visualizes raw `/v1/usage` samples from upstream. It shows a heatmap of daily activity, a timeline of samples and events, and daily aggregation with gap detection (`usage_gap_threshold_minutes` default 60).

## Config

- `usage_refresh_ms` (60000), `usage_history_enabled` (true)
- `usage_raw_retention_days` (7), `usage_gap_threshold_minutes` (60)
