# 06 — Coalesced continuous sampling

Type: grilling
Status: resolved
Blocked by: (none)

## Question

Sampling cadence for `usage_samples`.

## Answer

**Poll-linked with coalesce.** Write a row on every successful `/v1/usage`
fetch *unless* the new row is byte-identical to the last-written row (all
ambient fields equal). First write after any change always lands. Degradation
events bypass coalesce (always write).

### Rationale

Scales with **change rate**, not poll rate. When the system is idle (most of
the night for a human working a window), one row says "still zero" and the
rest dedupe. When activity is happening, every poll is captured.

- **A (every poll)** unbounded growth if `usage_refresh_ms` is tuned down for
  gate responsiveness — at 5s cadence, 17,280 rows/day (~43 MB/day, ~16
  GB/year). Not user-scale.
- **B (fixed 60s throttle)** decouples sample cadence from configured poll
  rate — surprising if the user tunes cadence for responsiveness.
- **D (adaptive — skip during pure idle)** destroys the "was I idle in UTC
  03:00?" signal — a gap is ambiguous (idle vs poll failure). The hypothesis
  is *literally about* distinguishing "active 24h" from "active in a working
  window." A visible zero is required, not an ambiguous gap.

C's byte-identical check is cheap (compare prior row's fields). The viz
interprets "no new row" as "previous state continued" — standard time-series
semantics. Idle zero is still *visible* (the first idle row lands, subsequent
identical rows skip).

The events table (Q4/Q5) guarantees every transition is captured with full
ambient context regardless of sample cadence, so the samples table's job is
purely "ambient density over time."

### Config

`usage_refresh_ms` already exists (default 60000ms, min 1000ms per
`src/config/validation.ts`). Sample cadence inherits this; no new config
knob for cadence.
