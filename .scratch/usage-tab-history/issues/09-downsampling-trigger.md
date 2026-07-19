# 09 — Startup + UTC-midnight downsampling job

Type: grilling
Status: resolved
Blocked by: (none)

## Question

When and how does raw samples collapse to daily aggregate?

## Answer

**Startup + UTC-midnight crossing.**

1. Run once at proxy startup (catches any days that aged out while the proxy
   was down).
2. Schedule next run at next UTC 00:00:00 crossing. `setTimeout` to next UTC
   midnight, then `setInterval` at 24h.
3. At each run: find all UTC days older than `now_utc − retention_days` that
   lack a `usage_daily` row, compute and insert their aggregates, then delete
   their raw rows. Events are never touched.

The job is idempotent: "find days older than retention that lack a
`usage_daily` row" is safe to run repeatedly. If the proxy was down for 3
days, the first startup run catches all 3 days in one pass.

### Read path is never blocked

Real-time reads of recent days hit `usage_samples` directly (≤2,800 rows,
fast SQLite SELECT). Historical reads hit `usage_daily` (precomputed, one
row per UTC day). The downsampling job runs off the read path entirely.

### Rationale

- The UTC-day boundary is already authoritative in the domain model
  (`window.started_at` resets at 00:00 UTC). Scheduling the downsampling job
  at UTC midnight keeps every temporal concept aligned to the same clock.
- **A (lazy on-read)** recomputes the same aggregate repeatedly while raw
  samples exist — wasteful CPU on the read path. Also can't prune raw samples
  until aggregate exists, which means pruning needs its own trigger anyway.
  Couples two concerns. Read-path writes are a surprising coupling.
- **B (every 6h)** is more responsive than C in theory but the extra
  responsiveness buys nothing: the daily aggregate is only consumed by the
  long-term pattern view, which doesn't care about a few hours of delay. And
  B's 6h timer fires 4× per day doing nothing most of the time.

C's UTC-midnight scheduling is cheap: `setTimeout` to next UTC midnight, then
`setInterval` at 24h. The startup run is a one-shot. Total: ~50 lines
including the SQL.

### Self-healing after long downtime

See ticket 10 for the `day_completeness` field that handles partial/missing
days when the proxy was down for an extended period (e.g., July 19 14:00 →
August 31 13:00).
