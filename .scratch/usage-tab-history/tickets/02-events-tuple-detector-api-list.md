# 02 — Events: storage, tuple diff detector, API, event list in tab

**What to build:** A new `usage_events` table captures every degradation transition. A stateful detector subscribed to the same `UmansUsageClient.onChange()` callback holds the last-seen priority tuple `{priorityLow, boxedUntil, boxedReason, unitsDemoted, demotedUntil}` and last-seen service_mode tuple `{current, resetsAt}`. On any tuple change, it writes an event row with `event_kind`, `transition` (onset/resolved/morph), `previous_event_id` (link to prior event of same kind for duration computation), and full ambient context at the moment of transition. A new `GET /dashboard/api/usage/events?from=&to=&kind=` endpoint returns events. The Usage tab now shows an event list alongside samples, with ban-onset timestamps visible. Trigger a priority-low or service_mode change in the mock upstream → see the event appear in the tab. This slice makes the "what was happening when the ban started?" question answerable from the event log alone.

**Blocked by:** 01 — Raw samples (needs the history module + onChange subscription established; shares the same module and the same startup gating)

**Status:** ready-for-agent

- [ ] `usage_events` table created at startup via `CREATE TABLE IF NOT EXISTS`, gated on `usage_history_enabled`. Indexed on `fetched_at` and `event_kind`.
- [ ] Stateful tuple detector added to `src/usage-history/`. Holds last-seen priority tuple + last-seen service_mode tuple. On each `onChange` snapshot, computes current tuples; if either differs from last-seen, emits an event row.
- [ ] `transition` classification: `onset` (all-clear → degraded), `resolved` (degraded → all-clear), `morph` (degraded → different degraded, e.g. `boxedUntil` extended).
- [ ] `previous_event_id` set to id of most recent prior event of same `event_kind`. Initial state (first-ever snapshot): no event emitted; detector seeds state silently.
- [ ] Event row carries full ambient context (concurrency raw + weighted + caps, requests + weighted + remaining + limits, tokens in/out/cached, derived `cacheHitRate` as 0–1 or null, window started_at/resets_at/remaining_minutes, fetched_at).
- [ ] `GET /dashboard/api/usage/events?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=priority|service_mode` returns events for the range (following the economics route pattern).
- [ ] Usage tab extended: event list view showing timestamps + event_kind + transition + boxed reason (if any). Shown alongside (or toggled with) the sample list from ticket 01.
- [ ] Integration test — mock upstream drives priority-low onset at T0, service_mode change at T1, all-clear at T2; fetch events API; assert 3 events with correct `transition` fields, correct `previous_event_id` links, and full ambient context at each transition. Assert no event emitted on first-ever snapshot.
- [ ] `bun run typecheck` passes; `bun run lint` clean; no type suppressions.
