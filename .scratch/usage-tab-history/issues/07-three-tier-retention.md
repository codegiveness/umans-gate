# 07 — Three-tier retention with downsampling

Type: grilling
Status: resolved
Blocked by: (none)

## Question

Storage strategy: how to keep the app user-scale ("real-time, light, fast")
while supporting months/years of pattern history.

## Answer

**Three-tier storage:**

| Tier | Table | What lives here | Retention | Row count estimate |
|---|---|---|---|---|
| Raw samples | `usage_samples` | One row per coalesced poll (Q6/C). Wide row: all ambient fields. | 7 days (configurable: `usage_raw_retention_days`, hot-reloadable, default 7) | ~200–400/day × 7 = ~2,800 rows max. ~7 MB uncompressed. |
| Daily aggregates | `usage_daily` | One row per UTC day: activity density, degradation burden, correlation fields. See ticket 08. | Forever (until DB ring-buffer prunes, if ever) | 365 rows/year. Negligible. |
| Events | `usage_events` | One row per degradation transition (Q4/Q5). Narrow row: transition + ambient context. | Forever | A few events/week at most. ~1,000 rows over 5 years. Negligible. |

**Total footprint after 1 year: ~7 MB (raw, rolling) + negligible (daily +
events) = under 10 MB.** User-scale.

**The downsampling job**: a periodic task (runs once on startup, then once
per UTC midnight crossing) scans `usage_samples` for rows older than the
retention window, computes the daily aggregate for any UTC day that's now
fully outside the window, inserts/updates the `usage_daily` row, then
deletes the raw rows. Events are never touched by this job — they're
permanent.

### Rationale

User consumes analytics **per day**. Long-term history needs *one summary row
per UTC day*, not every poll. Raw resolution is only useful for "zoom into
the last few days to see exactly what happened." After that, the daily
aggregate carries enough signal for "was this week worse than last month?"
pattern analysis.

- **B (two-tier, no daily aggregate — raw 30d then delete)** loses the
  monthly pattern view — which is exactly what "learn the pattern over
  history" requires. Can only see "when was I banned?" (events), not "was
  last month more active than this one?" (daily density).
- **C (events-only, no samples)** rejects the hypothesis's testability. Can't
  disprove "umans thinks I'm a 24h bot" if idle periods leave no trace.
- **D (daily-aggregate-only from the start)** loses intra-day resolution
  forever — but the hypothesis is specifically about *which UTC hours* bans
  cluster in. "Ban happened on Tuesday" is not enough; "ban happened at UTC
  03:00 on Tuesday, outside my 09:00–17:00 working window" is the signal.

Tier A preserves intra-day resolution for the recent week (raw) and summarizes
it for the long term (daily aggregate carries ban-onset-count + total-ban-
duration per day, plus the raw events table carries exact timestamps
forever).

### User-scale constraint

User-stated: "this app should be light weight so strategize wise resource
consumption, for analytics summary to eat that much resource is not for user
level." 16 GB/year (every-poll-forever at 5s cadence) is production-scale.
Three-tier retention keeps footprint at ~10 MB/year — user-scale.
