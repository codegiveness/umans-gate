# Models Tab Reference

> **Applies to:** umans-gate v0.4.0 · **Last updated:** 2026-07-26

## Tab

- **Name**: Models
- **Value**: `models`
- **Lazy**: Yes

## Component

| File | Component |
|---|---|
| dashboard/src/components/models-tab.tsx | ModelsTab |

## Data Source

- `ModelsClient` — src/models.ts
  - Fetches upstream model catalog on `models_refresh_ms` (default 3600000)
- `parseModelInfoResponse()` — src/model-info-parser.ts:98
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

## Purpose

Upstream model catalog with pricing and capability info:
- Model name, context window, pricing
- Reasoning capability (`can_disable`, effort levels)
- Stamp policy overlay matched per model
- Cache TTL and max output tokens

The parsed model info feeds the stamping pipeline (src/stamp-pipeline.ts)
so the proxy knows per-model thinking/effort behavior.

## Config

- `models_refresh_ms` (3600000) — refresh interval
