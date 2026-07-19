# 10 — day_completeness field for partial/missing days

Type: grilling
Status: resolved
Blocked by: (none)

## Question

How does the downsampling job handle days where the proxy was down for part
or all of the day? (Example: proxy shutdown July 19 14:00 UTC, restarted
August 31 13:00 UTC.)

## Answer

Add a `day_completeness` field to `usage_daily`:

- `"full"`: proxy observed the entire UTC 00:00–24:00 window for this day
- `"partial_start"`: first sample is after 00:00 UTC (proxy started mid-day)
- `"partial_end"`: last sample is before 24:00 UTC (proxy stopped mid-day)
- `"partial_both"`: both gaps present
- `"missing"`: zero samples exist for this UTC day (proxy was down all day).
  Row is written with NULLs for all activity fields, so the long-term
  calendar shows "no data" rather than a hole.
- `"incomplete_window"`: samples exist but with significant gaps mid-day
  (e.g., proxy crashed and restarted 6h later). Detected by gap-detection
  in the downsampling job: if `gap_minutes > threshold` (default 60min,
  configurable via `usage_gap_threshold_minutes`, hot-reloadable) **AND**
  the adjacent rows are *not byte-identical* (i.e., something actually
  changed, implying the proxy missed the transition).

### Self-healing on August 31 startup

1. Find the last `usage_daily` row's UTC date (say July 18 — the last fully-
   observed day).
2. For every UTC date from July 19 through August 30: check `usage_samples`
   for that date.
   - July 19: samples exist (partial) → aggregate with
     `day_completeness = "partial_end"`, `last_activity_utc_hour = 13`.
   - July 20–31, Aug 1–30: no samples → write `usage_daily` row with NULLs,
     `day_completeness = "missing"`.
3. August 31: it's today, within raw retention — leave raw samples alone, no
   aggregate yet.
4. Schedule next run at next UTC midnight (Sept 1 00:00 UTC) for August 31's
   aggregate.

**Storage cost of missing days:** one row per missing day, ~50 bytes each.
42 missing days = ~2 KB. Negligible.

### Rationale

Without the completeness flag, partial days get aggregated as if complete —
"July 19: 14h active, no ban" would look like a valid data point when in
reality the proxy died mid-day and the remaining 10h are unobserved. Silent
data-quality bug.

The flag lets the pattern view filter or annotate partial days. Hypothesis
analysis only treats `"full"` days as valid pattern data points.

- **B (drop partial-day handling)** silently corrupts long-term pattern
  data after every downtime. A user-scale app that silently corrupts data
  is a trap that surfaces months later when the pattern view lies.
- **C (don't aggregate partial days at all)** sounds clean but doesn't avoid
  the complexity — you still need completeness detection to decide *not* to
  aggregate. And it discards real data (July 19's 14h of observations) that
  could be useful if marked as partial.

The `day_completeness` field is one TEXT column. The partial-day detection is
~20 lines of SQL in the downsampling job. The missing-day backfill is ~10
lines. Total cost: trivial. Total value: the long-term view stays trustworthy
forever.
