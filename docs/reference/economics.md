# Economics Tab Reference

> **Applies to:** umans-gate v0.4.0 · **Last updated:** 2026-07-26

## Tab

- **Name**: Economics
- **Value**: `economics`
- **Lazy**: Yes

## Component

| File | Component |
|---|---|
| dashboard/src/components/economics-tab.tsx | EconomicsTab |

## Data Source

- src/economics.ts
  - `getMonthSummary(db, year, month)` — src/economics.ts:629
  - `getDailyUsage(db, limit)` — src/economics.ts:613
  - `getPricingTable(db)` — src/economics.ts:721
- Reads from `CaptureDB` (src/db.ts) token accounting

## REST Endpoints

All prefixed `/dashboard/api/`.

| Method | Path | Purpose |
|---|---|---|
| GET | /economics/summary | Monthly economics summary |
| GET | /economics/daily | Daily usage economics (default 90d, max 365) |
| GET | /economics/pricing | Pricing table |

No `/dashboard/api/economics` root route — only the three sub-routes above.

## WebSocket

- None specific
- Refresh by re-fetching REST endpoints

## Purpose

Daily usage accumulation and cost tracking. Shows:
- Monthly cost summary per model
- Daily usage trend (90-day default, up to 365)
- Pricing table used for cost computation

Pricing table sourced from upstream model catalog; daily/monthly aggregates
derived from capture token counts.
