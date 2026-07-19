# 08 — Daily aggregate field set (two-snapshot + two-dimension)

Type: grilling
Status: resolved
Blocked by: (none)

## Question

What fields does `usage_daily` carry?

## Answer

**Activity — Dimension A (accumulated):**
- `active_minutes` (INT) — sum of minutes with `concurrentSessions > 0` OR
  token/request counters changed
- `active_minutes_by_utc_hour` (TEXT JSON, 24 buckets: `{"00":12,"01":0,...}`)
  — shape of activity across the UTC day

**Activity — Dimension B (UTC clock span):**
- `activity_span_minutes` (INT) — `last_activity_utc − first_activity_utc`
  within this UTC day (0 if only one sample or no activity)
- `first_activity_utc_hour` (INT 0–23 or NULL)
- `last_activity_utc_hour` (INT 0–23 or NULL)

**Activity — Day-total (the "400M" side):**
- `tokens_in_total`, `tokens_out_total`, `tokens_cached_total` (INT) —
  cumulative for the UTC day
- `requests_in_window_peak`, `requests_in_window_avg`
- `cache_hit_rate_avg` (REAL)
- `concurrent_sessions_peak`, `concurrent_sessions_avg`
- `weighted_concurrent_sessions_peak`, `weighted_concurrent_sessions_avg`

**Activity — Trigger-moment (the "200M" side — captured at first priority
event and first service_mode event of the day):**
- `at_first_priority_event`: `{concurrent_sessions, weighted_concurrent_sessions,
  requests_in_window, weighted_requests_in_window, requests_in_window_remaining,
  requests_limit, tokens_in, tokens_out, tokens_cached, cache_hit_rate}`
- `at_first_service_mode_event`: same 10-field snapshot
- Both NULL if no event of that kind fired that day

**Degradation burden:**
- `priority_low_minutes`, `boxed_minutes`, `units_demoted_minutes`,
  `service_mode_non_normal_minutes`
- `priority_events_count`, `service_mode_events_count`
- `priority_ban_total_duration_ms`, `service_mode_ban_total_duration_ms`

**Static-for-the-day:**
- `concurrency_hard_cap`, `requests_limit`, `requests_hard_cap`

**Total: ~35 fields per daily row. 365 rows/year × 35 fields × ~50 bytes ≈
640 KB/year. Negligible.**

### Two-snapshot model (user clarification)

When a ban fires mid-day, there are *two distinct numbers* for each metric:
- **Trigger-moment value** (e.g., 200M tokens at 14:00 UTC when the ban
  started) → tells you *what triggered it*
- **Day-total value** (e.g., 400M tokens by 22:00 UTC after continuing work
  through the ban) → tells you *how much you actually consumed that day*

This applies to all ambient signals, not just tokens: requests, cache-hit-
rate, concurrency (raw + weighted).

### Two-dimension activity model (user clarification)

The 24h-window hypothesis has two independent dimensions:

| Dimension | What it measures | Example: work 08:00–12:00 + 13:00–14:00 + 23:00–01:00 | Bot-detection theory |
|---|---|---|---|
| **A — Accumulated active hours** | Sum of minutes where activity was actually happening | 4h + 1h + 2h = 7h active | "Humans work ≤8h, bots work 24h" |
| **B — UTC clock span** | `last_activity_utc − first_activity_utc` (same UTC day) | 08:00 → 24:00 (day N) = 16h span; 00:00 → 01:00 (day N+1) = 1h span | "umans simplistically computes span, assumes span > 8h = bot" |

**Hypothesis**: umans may flag on Dimension B (span), not Dimension A (actual
hours). A human working 09:00–17:00 has span=8h AND active=8h. A human working
08:00–12:00 + 23:00–01:00 has active=7h but span=16h (on day N, if split at
midnight). If umans flags the latter as bot-like, that's a Dimension-B flag.

The cross-midnight case is the tell: if umans resets at UTC 00:00, a
23:00–01:00 session splits into two short spans (1h each) and looks less
bot-like. If umans uses a rolling 24h window *not* anchored to UTC midnight,
the session looks like a continuous 2h span. The history reveals which one
umans uses — because ban-onsets are visible relative to per-UTC-day spans
(UTC-anchored) or rolling-window spans (not UTC-anchored). The events table
carries `windowStartedAt` at each ban, so the rolling-window case is testable
from event rows.

### Rationale

Every field traces to a hypothesis question. Dropping trigger-moment fields
(B) loses the long-term direct correlation test — after 7 days (raw
retention), the event rows still carry ambient context but can't be rolled
up to "over 3 months, what was the avg cache hit rate when a ban started?"
without joining to pruned samples.

Dropping per-hour activity map (C) loses the "which UTC hours was I active
in?" granularity over the long term — the very signal the "working window"
hypothesis needs. After 7 days, you can no longer see whether Tuesday's
activity was 09–17 or spread 00–24.

Expanding to full min/max/avg for every field (D) is the trap: "store
everything, decide later" is how user-scale apps become production monsters.
