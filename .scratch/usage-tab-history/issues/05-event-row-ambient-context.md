# 05 — Event row carries full ambient context at transition moment

Type: grilling
Status: resolved
Blocked by: (none)

## Question

Confirm the event-row ambient-context payload.

## Answer

When any degradation event fires (priority tuple change OR service_mode tuple
change), the row captures:

**Transition fields:**
- `event_kind`: `"priority"` | `"service_mode"`
- `transition`: `"onset"` | `"resolved"` | `"morph"`
- `priority_tuple_after`: `{priorityLow, boxedUntil, boxedReason,
  unitsDemoted, demotedUntil}` (null if event_kind is service_mode)
- `service_mode_tuple_after`: `{current, resetsAt}` (null if event_kind is
  priority)
- `previous_event_id`: link to prior state row for duration computation

**Ambient context fields** (sampled from the same `/v1/usage` poll that
detected the change):
- `concurrentSessions`, `weightedConcurrentSessions`
- `concurrencyHardCap`, `concurrencySoftLimit`
- `requestsInWindow`, `weightedRequestsInWindow`, `requestsRemaining`,
  `requestsLimit`, `requestsHardCap`, `requestsWindowSeconds`
- `tokensIn`, `tokensOut`, `tokensCached`, **`cacheHitRate`** (derived:
  `tokensCached / (tokensIn + tokensOut + tokensCached)`, stored as 0–1, null
  if all three are zero)
- `windowStartedAt`, `windowResetsAt`, `windowRemainingMinutes` — the UTC day
  anchor
- `fetchedAt` — moment of detection

### Rationale

The payload covers every signal the two hypotheses need: hard-cap theory
(concurrency + weighted concurrency + caps), token/cache theory (tokens +
cacheHitRate + requests), and UTC-day anchoring (windowStartedAt). Nothing
extra, nothing missing.

Trimming weighted fields (option B) blinds the spec to the more likely
actual trigger (umans publishes both raw and weighted sessions for a reason).
Storing the full `RawUsage` JSON (option C) couples the schema to upstream
shape drift — every umans field addition grows the row unboundedly.

`previous_event_id` makes ban-duration computable in pure SQL without a join
to the samples table — the event log is self-contained for "how long was I
boxed?" queries.

### User clarification captured

Two suspected triggers for service_mode:
1. **Quantitative** — tokens volume + cache-hit ratio + request count over the
   UTC day. Observable from `/v1/usage`.
2. **Qualitative** — "low interactivity = looks like automation" heuristic.
   Not observable; only the transition is logged.

UTC day boundary is authoritative: `window.started_at` / `window.resets_at`
align to 00:00 UTC. The umans "day" is a UTC calendar day, not a rolling 24h.
