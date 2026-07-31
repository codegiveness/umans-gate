# Economics Tab Reference

> **Applies to:** umans-gate v0.6.0 · **Last updated:** 2026-07-31

The Economics tab tracks daily usage accumulation and cost per model.

## Tab

- **Name**: Economics
- **Value**: `economics`
- **Lazy**: Yes

## Component

| File | Component |
|---|---|
| dashboard/src/components/economics-tab.tsx | EconomicsTab |

## Data source

- src/economics.ts
  - `getMonthSummary(db, year, month)` at src/economics.ts:629
  - `getDailyUsage(db, limit)` at src/economics.ts:613
  - `getPricingTable(db)` at src/economics.ts:721
- Reads from `CaptureDB` (src/db.ts) token accounting

## REST Endpoints

All prefixed `/dashboard/api/`.

| Method | Path | Purpose |
|---|---|---|
| GET | /economics/summary | Monthly economics summary |
| GET | /economics/daily | Daily usage economics (default 90d, max 365) |
| GET | /economics/pricing | Pricing table |

No `/dashboard/api/economics` root route; only the three sub-routes above.

## WebSocket

- None specific
- Refresh by re-fetching REST endpoints

## What the Economics Tab Shows

The Economics tab tracks daily usage accumulation and cost per model. It shows a monthly cost summary per model, a daily usage trend (90-day default, up to 365 days), and the pricing table used for cost computation. The pricing table is sourced from the upstream model catalog; daily and monthly aggregates are derived from capture token counts.
