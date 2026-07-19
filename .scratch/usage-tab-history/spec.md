---
Status: ready-for-agent
Triage: ready-for-agent
---

# Spec: Usage Tab for umans Provider Pattern History

## Problem Statement

As a umans-gate user, I suspect that umans (the upstream provider at
`api.code.umans.ai`) degrades my service in two ways — priority boxing
(triggered by hitting the concurrency hard cap) and service_mode banning
(triggered by an unknown combination of token volume, cache hit rate, request
count, and/or "low interactivity" heuristics that flag 24h-non-stop usage as
automation). The provider does not publish the thresholds for either signal,
so I cannot predict or confirm the triggers from documentation alone.

Today, the proxy already polls `/v1/usage` on a cadence (default 60s) and
exposes a live `UsageSnapshot` via `GET /dashboard/api/usage` and the gate
panel. But that snapshot is **point-in-time only** — there is no history. I
cannot look back at "what was my cache hit rate when the service_mode ban
fired last Tuesday?" or "do bans cluster in UTC hours outside my working
window over the last month?" The hypothesis is untestable without history.

I need a new dashboard tab — **Usage** — that records `/v1/usage` history
persistently and visualizes it so I can eyeball the pattern myself. The app
must stay user-scale: real-time, light, fast. No statistical correlation
layer, no auto-mitigation — just a clear visual surface for a human to spot
the pattern.

## Solution

Add a **Usage** dashboard tab that records umans `/v1/usage` history in
three SQLite tiers and visualizes it as a linked heatmap + timeline:

- **Heatmap** (primary view): UTC day × UTC hour grid. Cell background =
  activity density (active minutes in that hour). Cell border = degradation
  state (none / priority-low / boxed / service_mode non-normal), with border
  thickness = duration fraction. Click a day-cell → opens the timeline.
- **Timeline** (drill-down): 5 lanes (Concurrency, Requests, Token flow, Cache
  hit rate, Degradation state bands) for a single UTC day. Ban-onset vertical
  lines cross all lanes so the eye traces what was happening at the moment of
  each ban.

Storage is three-tier to stay user-scale (~10 MB/year footprint):

| Tier | Table | Retention | Purpose |
|---|---|---|---|
| Raw samples | `usage_samples` | 7 days (configurable) | High-resolution zoom for recent days |
| Daily aggregates | `usage_daily` | Forever | Long-term pattern view, one row per UTC day |
| Events | `usage_events` | Forever | Every degradation transition with full ambient context |

A downsampling job runs at proxy startup and once per UTC-midnight crossing:
it folds aged raw samples into a `usage_daily` row, then deletes the raw rows.
The job is idempotent and self-healing — if the proxy was down for days, it
backfills `usage_daily` rows with `day_completeness = "missing"` for the gap
days so the long-term calendar never has ambiguous holes.

The visualization is **visual correlation only** — a human spots the pattern.
No statistical computation, no auto-detection, no mitigation hooks back into
the gate. That's a separate future effort once the hypothesis is validated by
the visual layer.

## User Stories

### Storage & sampling

1. As a umans-gate user, I want every successful `/v1/usage` poll to be
   persisted as a sample row, so that I have a continuous ambient record of
   concurrency, tokens, requests, and window state over time.
2. As a umans-gate user, I want consecutive identical polls to be coalesced
   (only the first row after any change is written), so that idle periods
   don't inflate storage while still leaving a visible "still zero" row.
3. As a umans-gate user, I want sample cadence to scale with change rate
   rather than poll rate, so that tuning `usage_refresh_ms` down for gate
   responsiveness doesn't silently 16× my storage footprint.
4. As a umans-gate user, I want degradation transitions (priority tuple
   changes and service_mode tuple changes) to be logged as discrete event
   rows the instant they're detected, so that ban onsets and resolutions have
   exact timestamps regardless of sample coalescing.
5. As a umans-gate user, I want each event row to carry the full ambient
   context at the moment of the transition (concurrency, weighted
   concurrency, caps, requests, tokens, cache hit rate, window anchor), so
   that I can answer "what was happening when the ban started?" from the
   event log alone without joining back to samples.
6. As a umans-gate user, I want each event row to link to the previous event
   of the same kind via `previous_event_id`, so that ban duration is
   computable in pure SQL as `resolved_at − onset_at`.
7. As a umans-gate user, I want priority state to be logged as a single
   composite tuple (`priorityLow`, `boxedUntil`, `boxedReason`,
   `unitsDemoted`, `demotedUntil`) — not as separate per-field flips — so
   that "entered priority-low + boxed + demoted" is one onset event, not
   three rows at the same timestamp.
8. As a umans-gate user, I want service_mode state to be logged as a single
   composite tuple (`current`, `resetsAt`), so that "entered non-normal
   service_mode" is one onset event.
9. As a umans-gate user, I want event transitions to be classified as
   `onset` / `resolved` / `morph`, so that "the tuple changed but didn't
   cross all-clear" (e.g. `boxedUntil` extended) is distinguishable from a
   true ban start or end.

### Retention & downsampling

10. As a umans-gate user, I want raw samples older than 7 days to be
    automatically folded into a daily aggregate row and then deleted, so
    that the raw table stays small (~7 MB cap) regardless of how long the
    proxy runs.
11. As a umans-gate user, I want daily aggregate rows to persist forever
    (one per UTC day), so that I can compare "was last month more active
    than this one?" over a long time horizon.
12. As a umans-gate user, I want event rows to persist forever, so that
    every ban I've ever experienced remains queryable by exact timestamp
    and ambient context.
13. As a umans-gate user, I want the downsampling job to run once at proxy
    startup and then once per UTC-midnight crossing, so that days aged out
    while the proxy was down are caught up on restart.
14. As a umans-gate user, I want the downsampling job to be idempotent, so
    that running it repeatedly (e.g., after multiple restarts in a day)
    never double-counts or corrupts aggregates.
15. As a umans-gate user, I want `usage_raw_retention_days` to be
    configurable and hot-reloadable (default 7), so that I can tune the
    raw-resolution window without restarting the proxy.
16. As a umans-gate user, I want the read path (fetching samples, events,
    daily aggregates for the dashboard) to never be blocked by the
    downsampling job, so that the dashboard stays responsive.

### Completeness & self-healing

17. As a umans-gate user, I want partial UTC days (proxy started mid-day or
    stopped mid-day) to be flagged with `day_completeness` =
    `partial_start` / `partial_end` / `partial_both`, so that the pattern
    view can filter or annotate them rather than treating them as valid
    full-day data points.
18. As a umans-gate user, I want UTC days with zero samples (proxy was down
    all day) to be backfilled with a `usage_daily` row carrying
    `day_completeness = "missing"` and NULL activity fields, so that the
    long-term calendar shows continuous dates with a clear "no data"
    marker rather than an ambiguous hole.
19. As a umans-gate user, I want mid-day gaps in samples (e.g., proxy
    crashed and restarted 6h later) to be flagged with
    `day_completeness = "incomplete_window"`, so that I don't treat a
    gap-filled day as a valid pattern data point.
20. As a umans-gate user, I want the gap-detection threshold to be
    configurable via `usage_gap_threshold_minutes` (default 60,
    hot-reloadable), so that I can tune it to my machine's sleep behavior
    without restarting.
21. As a umans-gate user, I want the gap detector to only flag a gap when
    the adjacent samples are *not byte-identical*, so that legitimate
    idle-coalesce gaps (where nothing changed) aren't false-positive flagged
    as incompleteness.

### Daily aggregate fields

22. As a umans-gate user, I want each daily aggregate row to carry a
    two-snapshot model for every ambient signal — a trigger-moment snapshot
    (captured at the first priority event and first service_mode event of
    the day) and a day-total snapshot — so that I can distinguish "what
    triggered the ban" from "how much I actually consumed that day."
23. As a umans-gate user, I want the daily aggregate to record both
    Dimension A (accumulated active minutes) and Dimension B (UTC clock
    span = `last_activity_utc − first_activity_utc`), so that I can test
    whether umans flags on actual hours worked or on the simplified
    clock-span heuristic.
24. As a umans-gate user, I want the daily aggregate to carry
    `active_minutes_by_utc_hour` as a 24-bucket JSON object, so that the
    long-term view preserves which UTC hours I was active in (not just
    daily totals) even after raw samples are pruned.
25. As a umans-gate user, I want the daily aggregate to record
    `first_activity_utc_hour` and `last_activity_utc_hour`, so that the
    Dimension B span is visible at a glance in the long-term view.
26. As a umans-gate user, I want the daily aggregate to carry degradation
    burden fields (priority_low_minutes, boxed_minutes,
    units_demoted_minutes, service_mode_non_normal_minutes, event counts,
    total ban durations), so that "how much of this UTC day was I
    throttled?" is answerable from one row.
27. As a umans-gate user, I want the daily aggregate to carry the
    trigger-moment ambient context for the first priority event and first
    service_mode event of the day (concurrency, weighted concurrency,
    requests, weighted requests, requests remaining, requests limit,
    tokens in/out/cached, cache hit rate), so that the long-term view can
    roll up "over 3 months, what was the avg cache hit rate when a ban
    started?" without joining to pruned samples.
28. As a umans-gate user, I want the daily aggregate to carry the static
    for-the-day limits (`concurrency_hard_cap`, `requests_limit`,
    `requests_hard_cap`), so that the pattern view shows what my capacity
    was on each day.

### Heatmap visualization

29. As a umans-gate user, I want the Usage tab to default to showing the
    last 30 days on the heatmap, so that I see enough data to spot a
    pattern without being overwhelmed by a wall of cells.
30. As a umans-gate user, I want preset range selectors (7d / 30d / 90d /
    1y / all), so that I can quickly zoom to a common time horizon.
31. As a umans-gate user, I want to brush-to-zoom on the heatmap itself
    (click-drag a date range to zoom in, double-click to reset), so that I
    can focus on a suspicious cluster of cells fluidly without fitting my
    question to a preset.
32. As a umans-gate user, I want heatmap cell background color to encode
    activity density (active minutes in that UTC hour, 4–5 intensity
    steps), so that "was I active?" is visible at a glance.
33. As a umans-gate user, I want heatmap cell border color to encode
    degradation state (no border / yellow = priority-low / orange = boxed
    / red = service_mode non-normal), so that "was I degraded?" is visible
    at a glance and doesn't compete with the activity signal.
34. As a umans-gate user, I want heatmap cell border thickness to encode
    degradation duration fraction (how much of that hour was degraded),
    so that I can scan the heatmap and see both *when* bans happened and
    *how long* they lasted without drilling into every event.
35. As a umans-gate user, I want a cell with pale background and a red
    border to be visually distinctive, so that the anomaly "low activity +
    still degraded" (which my hypothesis predicts as the fingerprint of
    Dimension B / UTC-span flagging) jumps out when scrolling.

### Timeline drill-down

36. As a umans-gate user, I want clicking a heatmap day-cell to open a
    timeline for that UTC day, so that I can drill from "I see a pattern"
    to "what exactly happened on this day?"
37. As a umans-gate user, I want the timeline to show 5 lanes —
    Concurrency (raw + weighted + hard_cap line), Requests (in window +
    limit + remaining), Token flow (in/out/cached stacked), Cache hit rate
    (line 0–100% + historical average marker), and Degradation state (full
    -width bands) — so that each lane maps to one of my hypotheses and I
    can read them in parallel.
38. As a umans-gate user, I want ban-onset vertical lines to cross all
    timeline lanes, so that my eye instantly traces from "ban fired here"
    upward to "what was concurrency / requests / tokens / cache hit rate
    at that exact moment?"
39. As a umans-gate user, I want the cache hit rate lane to carry a
    horizontal threshold marker at my 30-day historical average, so that I
    can compare "cache hit rate was 45% at the ban" against my typical
    baseline rather than reading it in isolation.
40. As a umans-gate user, I want days older than 7 days (raw samples
    pruned) to render as a hybrid step-function timeline — event markers
    at exact times with dashed held-constant segments between events — so
    that I can still see the shape of an old day without misleading solid
    curves that imply observed data where none exists.
41. As a umans-gate user, I want degradation bands on old-day timelines
    to span from real onset timestamps to real resolution timestamps, so
    that ban duration remains visually accurate even when raw samples are
    gone.
42. As a umans-gate user, I want the timeline for days ≤7 days old to
    render full-resolution solid curves from raw samples, so that recent
    drill-downs show actual observed data, not held-constant steps.

### API & live updates

43. As a umans-gate user, I want REST endpoints at
    `/dashboard/api/usage/samples`, `/dashboard/api/usage/daily`, and
    `/dashboard/api/usage/events` (following the existing
    `/dashboard/api/economics/*` pattern), so that the dashboard can fetch
    history by date range.
44. As a umans-gate user, I want the Usage tab to subscribe to live
    WebSocket updates (new sample written → recent-day view refreshes
    without manual reload), so that the "real-time" preference is
    satisfied for the recent window.
45. As a umans-gate user, I want the existing `GET /dashboard/api/usage`
    (live snapshot) endpoint to remain unchanged, so that the gate panel
    and other consumers don't break.

### Configuration

46. As a umans-gate user, I want `usage_history_enabled` (default true) to
    toggle the entire history feature without uninstalling, so that I can
    disable it if I don't want the storage overhead.
47. As a umans-gate user, I want `usage_raw_retention_days` (default 7,
    hot-reloadable) to control how long raw samples live before
    downsampling, so that I can trade storage for zoom-in resolution.
48. As a umans-gate user, I want `usage_gap_threshold_minutes` (default
    60, hot-reloadable, min 5) to control the incompleteness detector, so
    that I can tune it to my machine's behavior.
49. As a umans-gate user, I want all three new config knobs to follow the
    existing hot-reload pattern (`breaker_*`, `rate_limit_*`,
    `stamp_claude_code_enabled`), so that config changes apply without a
    restart.
50. As a umans-gate user, I want the new config knobs to have JSON
    `snake_case` equivalents (matching the existing
    `usage_refresh_ms` ↔ `USAGE_REFRESH_MS` convention), so that I can
    set them either via environment variable or via `config.json`.

### UI constraints

51. As a umans-gate user, I want the Usage tab to use shadcn/ui primitives
    wherever possible, so that the tab is visually consistent with the
    rest of the dashboard (Captures, Config, Economics, Models tabs).
52. As a umans-gate user, I want to be asked before any non-shadcn
    component is introduced, so that the dependency footprint stays
    intentional.
53. As a umans-gate user, I want the heatmap cells to be plain `<div>`
    elements with Tailwind classes (the shadcn-idiomatic way to build
    cards/badges), so that no external heatmap library is introduced.
54. As a umans-gate user, I want the timeline to use the shadcn `Chart`
    component (built on Recharts, already a dependency), so that no new
    charting library is introduced.

## Implementation Decisions

### Architecture

- **New module**: `src/usage-history/` — owns the three new SQLite tables,
  the sample writer, the event detector, the downsampling job, and the
  query functions for the dashboard API. Single responsibility: persistent
  usage history. Does NOT touch stamp logic, capture storage, or gate
  behavior.
- **Existing module modified**: `src/usage/aggregator.ts` —
  `UmansUsageClient.onChange()` callback is the hook point. The history
  module subscribes to it; on each snapshot, it (a) writes a coalesced
  sample row and (b) runs the event-tuple diff and writes event rows if
  any transition fired. The aggregator itself stays unaware of persistence
  (DIP: depend on the callback interface, not on the history module).
- **Existing module extended**: `src/viewer.ts` — three new routes added
  to the `ROUTES` table following the existing `economics/*` pattern:
  `GET /dashboard/api/usage/samples`, `GET /dashboard/api/usage/daily`,
  `GET /dashboard/api/usage/events`. The existing `GET
  /dashboard/api/usage` (live snapshot) is untouched.
- **Existing module extended**: `src/config/{types,validation,defaults,
  loader,reload}.ts` — three new config knobs added following the existing
  hot-reload pattern.
- **New dashboard component**: `dashboard/src/components/usage-tab.tsx` +
  `dashboard/src/hooks/use-usage-history.ts` — mirrors the
  `economics-tab.tsx` + `use-economics.ts` pattern. Tab registered in
  `dashboard/src/App.tsx` alongside Captures, Config, Economics, Models.
- **WS broadcast extended**: `src/ws.ts` — new message type for usage
  history updates (new sample / new event). Shape to be decided during
  implementation; follows the existing `WsMessage` discriminated union.

### Schema changes

Three new SQLite tables (all WAL, in the same `capture.db`):

- `usage_samples` — one row per coalesced poll. Columns: `id` (PK),
  `fetched_at` (ms epoch), all ambient fields from `UsageSnapshot` (ok,
  fetched_at, plan, plan_slug, requests_*, concurrency_*, tokens_*,
  window_*, priority_*, service_mode_*). Indexed on `fetched_at`.
- `usage_events` — one row per degradation transition. Columns: `id` (PK),
  `fetched_at`, `event_kind` ('priority' | 'service_mode'), `transition`
  ('onset' | 'resolved' | 'morph'), `priority_tuple_after` (JSON),
  `service_mode_tuple_after` (JSON), `previous_event_id` (FK to
  `usage_events.id`), all ambient context fields (same set as samples).
  Indexed on `fetched_at` and `event_kind`.
- `usage_daily` — one row per UTC day. Columns: `utc_date` (PK,
  'YYYY-MM-DD'), `day_completeness` ('full' | 'partial_start' |
  'partial_end' | 'partial_both' | 'missing' | 'incomplete_window'),
  Dimension A fields (`active_minutes`, `active_minutes_by_utc_hour` JSON),
  Dimension B fields (`activity_span_minutes`, `first_activity_utc_hour`,
  `last_activity_utc_hour`), day-total fields (tokens_*_total, requests_*,
  cache_hit_rate_avg, concurrent_sessions_*), trigger-moment fields
  (`at_first_priority_event` JSON, `at_first_service_mode_event` JSON),
  degradation burden fields (priority_low_minutes, boxed_minutes, etc.),
  static-for-day fields (concurrency_hard_cap, requests_limit,
  requests_hard_cap).

The schema migration runs at proxy startup, gated on `usage_history_enabled`.
Existing `capture.db` databases get the new tables added via
`CREATE TABLE IF NOT EXISTS` (the same pattern the codebase uses for the
economics and vision-description tables).

### Event detection logic

A stateful detector subscribed to `UmansUsageClient.onChange()`:

- Holds the last-seen priority tuple and last-seen service_mode tuple.
- On each snapshot, computes the current tuples. If either differs from
  last-seen, emits an event row with the appropriate `transition`:
  - `onset`: last-seen was all-clear, current is degraded
  - `resolved`: last-seen was degraded, current is all-clear
  - `morph`: both were non-clear, tuple changed but didn't cross all-clear
- The event row's `previous_event_id` is set to the id of the most recent
  prior event of the same `event_kind`.
- Initial state (no prior snapshot): no event emitted on the first poll;
  the detector seeds its state silently.

### Sample coalescing logic

On each successful snapshot (ok=true), the writer compares the new row's
ambient fields byte-for-byte against the last-written sample row. If
identical, the write is skipped. If any field differs, the row is written.
Degradation events always bypass coalescing (they're in a separate table).

### Downsampling job

- **Trigger**: once at proxy startup, then `setTimeout` to next UTC
  00:00:00, then `setInterval` at 24h.
- **Logic**: find UTC dates older than `now_utc − usage_raw_retention_days`
  that lack a `usage_daily` row. For each:
  1. Query `usage_samples` for that UTC date.
  2. If no samples: write `usage_daily` row with `day_completeness =
     "missing"` and NULL activity fields.
  3. If samples exist: compute the aggregate. Detect completeness:
     - First sample's UTC hour > 0 → `partial_start`
     - Last sample's UTC hour < 23 → `partial_end`
     - Both → `partial_both`
     - Mid-day gaps > `usage_gap_threshold_minutes` with non-identical
       adjacent rows → `incomplete_window`
     - Otherwise → `full`
  4. Insert the `usage_daily` row.
  5. Delete the raw samples for that UTC date.
- **Idempotency**: "find dates lacking a `usage_daily` row" is safe to run
  repeatedly. An existing row is never overwritten by the downsampling job
  (it's only written once, when the day ages out of raw retention).
- **Events are never touched** by this job.

### Cache hit rate derivation

`cacheHitRate = tokensCached / (tokensIn + tokensOut + tokensCached)`,
stored as a real number 0–1. Null if all three token fields are zero (no
traffic to measure). Computed at write time for samples and event rows;
stored as a precomputed column in `usage_daily` aggregates.

### API contracts

All three new endpoints follow the existing
`/dashboard/api/economics/*` pattern (path-param or query-param date
ranges, JSON response, dashboard-token auth inherited from the existing
viewer middleware):

- `GET /dashboard/api/usage/samples?date=YYYY-MM-DD&limit=N` — returns
  raw sample rows for the given UTC day (or recent N if no date). Used for
  the timeline drill-down (≤7 days old).
- `GET /dashboard/api/usage/daily?from=YYYY-MM-DD&to=YYYY-MM-DD` — returns
  daily aggregate rows for the range. Used for the heatmap.
- `GET /dashboard/api/usage/events?from=YYYY-MM-DD&to=YYYY-MM-DD&kind=priority|service_mode`
  — returns event rows for the range. Used for heatmap event markers and
  the timeline's degradation bands (especially for old days where raw
  samples are pruned).

Exact query param names and pagination behavior are implementation
details; the contracts above are the spec.

### Visualization primitives

- **Heatmap**: plain `<div>` grid with Tailwind classes for background
  intensity (4–5 steps) and border color/thickness (4 states × 3
  thickness steps). No external heatmap library. shadcn-idiomatic.
- **Timeline**: shadcn `Chart` component (built on Recharts, already a
  dependency via shadcn). Uses `Line`, `Area`, `ReferenceLine`, and
  `ReferenceArea` primitives. Step-functions via Recharts `step` prop;
  dashed lines via `strokeDasharray`.
- **Range selector**: shadcn `Select` or `DropdownMenu` for presets.
  Brush-to-zoom via Recharts `Brush` component (comes through shadcn's
  Chart wrapper; not a separate library).
- **Lane 5 degradation bands**: `ReferenceArea` spanning full width,
  colored by state. Ban-onset vertical lines: `ReferenceLine` with
  `x={timestamp}`.

### Config schema migration

Three new fields added to `RawConfig` and `ProxyConfig`:

- `usage_history_enabled: boolean` (default true, hot-reloadable)
- `usage_raw_retention_days: number` (default 7, hot-reloadable, integer
  ≥ 1)
- `usage_gap_threshold_minutes: number` (default 60, hot-reloadable,
  integer ≥ 5)

All three added to the hot-reload allowlist in `src/config/reload.ts`
alongside `breaker_*`, `rate_limit_*`, `stamp_claude_code_enabled`. All
three have `snake_case` JSON equivalents in `config.json` and
`UPPER_SNAKE_CASE` env var equivalents, matching the existing
`usage_refresh_ms` convention.

### Domain glossary additions (to `CONTEXT.md`)

Per the domain-modeling skill, the following terms should be captured in
`CONTEXT.md` during implementation:

- **Priority tuple** — the composite priority state
  `{priorityLow, boxedUntil, boxedReason, unitsDemoted, demotedUntil}`.
  One event per tuple change, not per field.
- **Service_mode tuple** — `{current, resetsAt}`. One event per tuple
  change.
- **Dimension A (accumulated active hours)** — sum of minutes where
  activity was actually happening. Bot-detection theory: "humans work
  ≤8h, bots work 24h."
- **Dimension B (UTC clock span)** — `last_activity_utc −
  first_activity_utc` within a UTC day. Bot-detection theory: "umans
  simplistically computes span, assumes span > 8h = bot." Distinct from
  Dimension A: a human working 08:00–12:00 + 23:00–01:00 has
  Dimension A = 7h but Dimension B = 16h (on day N, if split at UTC
  midnight).
- **day_completeness** — the completeness flag on a `usage_daily` row:
  `full` / `partial_start` / `partial_end` / `partial_both` / `missing`
  / `incomplete_window`. Used to filter or annotate partial days in the
  pattern view.
- **cacheHitRate (history)** — `tokensCached / (tokensIn + tokensOut +
  tokensCached)`, stored as 0–1. Distinct from the per-capture
  `cached_pct` (which uses `total_input_tokens` as denominator). The
  history variant uses the `/v1/usage` token counters, not per-request
  capture data.

Note: this is a *new* `cacheHitRate` concept distinct from the existing
`cached_pct` in `CONTEXT.md`. The glossary entry must make the distinction
explicit to avoid ambiguity.

### SOLID compliance

- **SRP**: `src/usage-history/` owns only persistent usage history. Stamp
  logic stays in `stamp.ts`; live usage state stays in
  `src/usage/aggregator.ts`; capture storage stays in `src/db.ts`.
- **OCP**: the event detector is extensible to new tuple kinds (e.g., a
  future `rate_limit` tuple) without modifying the existing priority and
  service_mode detectors — each tuple kind is a separate comparator.
- **LSP**: the history module's writer interface (subscribe to
  `onChange`) is substitutable — any future snapshot source implementing
  the same callback shape works.
- **ISP**: the history module exposes narrow query functions
  (`getSamples`, `getDaily`, `getEvents`) to the viewer router, not the
  whole storage surface.
- **DIP**: the history module depends on the `onChange` callback
  interface, not on `UmansUsageClient` directly. The aggregator doesn't
  know about persistence.

## Testing Decisions

### What makes a good test

Tests verify **external behavior** (HTTP API responses, dashboard-rendered
output), not implementation details (SQL schema shape, internal function
signatures, coalesce algorithm internals). A test that breaks when we
rename a column but the API response is unchanged is a bad test. A test
that breaks when a ban-onset timestamp is off by one second is a good
test.

### Primary seam: end-to-end integration

Pattern from `test/usage-dashboard.test.ts` (spawn proxy + mock upstream
→ drive `/v1/usage` mock → fetch dashboard API → assert on rows). One
primary seam covers the whole feature:

1. Spawn proxy with a mock upstream that serves scripted `/v1/usage`
   responses (priority-low onset at T0, service_mode change at T1,
   all-clear at T2).
2. Let the usage poll cycle fire a few times.
3. `GET /dashboard/api/usage/samples?date=YYYY-MM-DD` → assert coalesced
   samples exist and carry ambient context.
4. `GET /dashboard/api/usage/events?date=YYYY-MM-DD` → assert priority
   and service_mode transitions were captured with full ambient context,
   `previous_event_id` links, and `transition` field.
5. `GET /dashboard/api/usage/daily?date=YYYY-MM-DD` → assert daily
   aggregate has correct two-snapshot fields, two-dimension activity, and
   `day_completeness`.
6. Drive the mock upstream through a multi-day scenario (UTC midnight
   crossing) → assert the downsampling job collapsed raw samples into the
   daily aggregate and pruned raw rows.
7. Stop and restart the proxy with a gap in mock time → assert
   `day_completeness = "missing"` for gap days and `"partial_end"` /
   `"partial_start"` at boundaries.
8. Assert the coalesce rule: drive identical snapshots → assert only one
   sample row was written (query via API).
9. Assert the gap detector: drive a 90-minute gap with non-identical
   adjacent snapshots → assert `day_completeness = "incomplete_window"`.

### Secondary seam: dashboard hook + component

Pattern from `dashboard/src/components/economics-tab.tsx` + its test
(vitest + jsdom, mock fetch, assert hook returns right shape and
component renders without crashing). Mirrors existing prior art — not a
new seam.

### Modules tested

- `src/usage-history/` (new) — tested via the integration seam above.
- `src/viewer.ts` extended routes — tested via the same integration seam
  (the API is the integration surface).
- `dashboard/src/components/usage-tab.tsx` + `use-usage-history.ts` (new)
  — tested via the dashboard seam.

### Modules NOT tested in isolation

- Event-tuple diffing, sample coalescing, cache hit rate derivation, gap
  detection — all exercised through the integration seam via their
  observable effects on API responses. If any of these becomes complex
  enough to warrant a unit test during implementation, that's a judgment
  call at the time, not a seam decision now.

### Prior art

- `test/usage-dashboard.test.ts` — integration test pattern with proxy +
  mock upstream + dashboard API assertions.
- `test/usage-priority-low-clear.test.ts` — testing priority-low
  transitions through the existing usage module.
- `test/usage-fetch-timeout.test.ts` — testing failure paths in the usage
  poll cycle.
- `test/usage-nan-poisoning.test.ts` — testing edge cases in snapshot
  construction.
- `dashboard/src/components/economics-tab.tsx` — dashboard tab pattern
  with shadcn Select/Card/Table + `useEconomics` hook.

## Out of Scope

- **Statistical correlation layer**: computing "ban probability rises
  with X" automatically. Ship the visual layer first; if the pattern is
  visible, a statistical layer becomes a separate future effort with its
  own map.
- **Auto-detection / mitigation**: live "looks like automation" classifier
  + action hook back into the gate. Speculative until the hypothesis is
  validated by the visual layer.
- **Multi-account aggregation**: the proxy serves one umans account.
  Tracking multiple accounts' usage patterns is a different product.
- **Export to CSV / external analytics**: the Usage tab is for in-
  dashboard eyeballing. If export is needed later, it's a trivial addition
  but not part of this spec.
- **Alerting / notifications** (e.g., "you've been banned for >2h"): not
  part of the visual-correlation goal. The existing gate panel already
  shows live state.
- **Mobile-responsive layout**: the heatmap + timeline is a desktop-first
  analytics surface. Mobile can be added later if needed.
- **Long-term event retention rollup**: events are "forever" per the
  three-tier design, but after 2+ years that's a few thousand rows — fine.
  Rolling very old events into monthly summaries is premature to decide
  without seeing actual event volume. Revisit after 6 months of real data.
- **WS broadcast message shape**: the new WS message type for usage
  history updates is noted as fog in the wayfinder map. The shape
  (new-sample vs new-event, broadcast cadence, payload fields) is an
  implementation decision, not a spec decision. The existing `WsMessage`
  discriminated union is extended, not replaced.
- **Exact API query parameter names and pagination behavior**: the
  contracts in Implementation Decisions specify the endpoints and their
  purpose. Whether `?date=` vs `?day=` vs `?from=&to=` is the canonical
  form, and whether pagination is cursor-based or limit-based, are
  implementation details.
- **`CONTEXT.md` glossary entry wording**: the terms to capture are
  listed in Implementation Decisions. The exact prose is written during
  implementation per the domain-modeling skill.

## Further Notes

### User-scale constraint (load-bearing)

This is a **personal-use project** (per `README.md` and `AGENTS.md`). The
user stated explicitly: "this app should be light weight so strategize
wise resource consumption, for analytics summary to eat that much resource
is not for user level." Every storage, cadence, and retention decision in
this spec is calibrated to keep the footprint at ~10 MB/year — user-scale,
not production-scale. The three-tier retention design is the primary
mechanism: raw samples 7 days (~7 MB cap), daily aggregates forever
(~640 KB/year), events forever (~50 KB over 5 years). Any implementation
decision that risks growing the footprint beyond user-scale must be
rejected.

### Real-time, light, fast (user-stated preference)

The user stated: "i want data is real time and light and fast." This
means:

- **Real-time**: the recent-days view reads raw samples directly; no
  background job mediates the read path. The WS broadcast keeps the view
  live without manual refresh.
- **Light**: three-tier retention keeps storage ~10 MB/year. No external
  DB, no external collector, no background process.
- **Fast**: dashboard reads hit SQLite SELECT on tables with ≤2,800 rows
  (raw samples) or ≤365 rows (daily aggregates). Indexes on `fetched_at`
  and `utc_date` keep queries sub-millisecond.

### shadcn constraint (user-stated)

The user stated: "use full shadcn as possible if not available on shadcn
ask me first for using other alternatives." This spec proposes:

- Heatmap: plain `<div>` + Tailwind classes (shadcn-idiomatic, no new
  library).
- Timeline + range selector + brush: shadcn `Chart` + `Select` +
  `DropdownMenu` (Recharts comes through shadcn's Chart wrapper; not a
  separate library).

If during implementation a need arises for a component not in shadcn, the
implementer must ask the user before substituting. This is a hard
constraint, not a preference.

### Wayfinder map

This spec was synthesized from a wayfinder map at
`.scratch/usage-tab-history/map.md` with 16 resolved decision tickets at
`.scratch/usage-tab-history/issues/01-16-*.md`. The map's "Not yet
specified" section (WS broadcast shape, API route query params, config
schema migration details, `CONTEXT.md` glossary entries, long-term event
retention) is carried forward into this spec's "Out of Scope" section —
those are implementation decisions, not spec decisions.

### Hypothesis context (not part of the spec, but load-bearing for why)

The user's hypothesis, which this spec is designed to make testable:

1. **Priority boxing** is triggered by hitting `concurrencyHardCap`
   (known, observable).
2. **Service_mode banning** is triggered by an unknown combination of:
   - Token volume (in + out + cached) over the UTC day
   - Cache hit rate (low ratio = "not caching well" = suspicious)
   - Request count over the UTC day
   - "Low interactivity" heuristic that flags 24h-non-stop usage as
     automation — potentially computed as Dimension B (UTC clock span)
     rather than Dimension A (accumulated active hours)

The provider does not publish thresholds for either signal. This spec
records the history needed to visually test the hypothesis; it does not
attempt to prove or disprove it. Validation is a human eyeballing the
heatmap after a few weeks of data.
