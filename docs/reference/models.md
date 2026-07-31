# Models Tab Reference

> **Applies to:** umans-gate v0.6.1 · **Last updated:** 2026-07-31

The Models tab displays the upstream model catalog with pricing and capability metadata.

## Tab

- **Name**: Models
- **Value**: `models`
- **Lazy**: Yes

## Component

| File | Component |
|---|---|
| dashboard/src/components/models-tab.tsx | ModelsTab |

## Data source

- `ModelsClient` (src/models.ts)
  - Fetches upstream model catalog on `models_refresh_ms` (default 3600000)
- `parseModelInfoResponse()` at src/model-info-parser.ts:98
  - Parses `/v1/models/info` response
  - Populates `StampPolicy` via `matchStampOverlay()` (src/stamp-catalog.ts:131)
- Backing fetch: src/models/fetch-info.ts

## REST Endpoints

All prefixed `/dashboard/api/`.

| Method | Path | Purpose |
|---|---|---|
| GET | /models | Upstream model catalog (with parsed info) |

## WebSocket

- None specific
- Refreshed on `models_refresh_ms` interval or manual refetch

## What the Models Tab Shows

The Models tab displays the upstream model catalog with pricing and capability info. It shows model name, context window, pricing, reasoning capability (`can_disable`, effort levels), stamp policy overlay, cache TTL, and max output tokens. The parsed model info feeds the stamping pipeline (src/stamp-pipeline.ts) so the proxy knows per-model thinking and effort behavior.

## Config

- `models_refresh_ms` (3600000): refresh interval
