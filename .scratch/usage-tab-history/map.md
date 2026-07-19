# Map: Usage Tab for umans Provider Pattern History

## Destination

A spec for a new "Usage" dashboard tab that records umans `/v1/usage` history
(priority state, service_mode, concurrency, tokens, requests, cache hit rate)
and visualizes it as a UTC-day × UTC-hour heatmap with a linked per-day timeline
drill-down. The goal: let a human eyeball whether priority boxing and service_mode
degradation correlate with their UTC working window — testing the hypothesis
that umans flags "looks like 24h automation" via Dimension B (UTC clock span)
and/or token-volume + cache-hit-rate + request-count thresholds.

Plan-don't-do. The map delivers decisions; implementation is a separate effort.

## Notes

- **Domain**: umans-gate proxy. Existing modules to extend: `src/usage/aggregator.ts`
  (`UmansUsageClient`), `src/db.ts` (capture store, WAL), `src/viewer.ts`
  (REST API router), `dashboard/src/App.tsx` (tab registration).
- **Existing precedent**: `economics` module (daily usage table + month summary
  + pricing) is the pattern to follow for a new persisted surface.
- **Runtime**: Bun + SQLite (`bun:sqlite`). All storage is SQLite; no external DB.
- **UI constraint (user-stated)**: prefer shadcn/ui primitives. If a needed
  component is not in shadcn, ASK THE USER before substituting. Recharts
  (the rendering engine shadcn's `Chart` component is built on) is treated as
  "available on shadcn" — already a dependency via shadcn.
- **Skills every session should consult**: `grilling` (one question at a time),
  `domain-modeling` (capture terms in `CONTEXT.md` as they crystallize).
- **Standing preferences**: user-scale app — "real-time, light, fast for
  personal use." Every storage/cadence/retention decision must stay user-scale
  (~10 MB/year footprint, not production-scale). No speculative features.
- **Hot-reloadable config pattern** (already established in codebase for
  `breaker_*`, `rate_limit_*`, `stamp_claude_code_enabled`): new config knobs
  follow this pattern.
- **SOLID**: each new module has one responsibility. Stamp logic stays in
  `stamp.ts`; usage persistence goes in a new `src/usage-history/` module,
  not into `db.ts` or `aggregator.ts`. Inject dependencies, don't import
  concrete modules deep in business logic.

## Decisions so far

- [Destination is a spec, not shipped code](./issues/01-destination-is-spec.md) — Wayfinder plan-don't-do; deliver decisions, hand off implementation.
- [Visual correlation only, no statistical layer](./issues/02-visual-correlation-only.md) — A human eyeballs the UTC 24h grid; no auto-correlation or mitigation in this effort.
- [Two storage tables: continuous samples + state-change events](./issues/03-two-tables-samples-events.md) — Ambient signal (samples) + discrete transitions (events) for ban onset/duration.
- [Composite event tuples, not per-field flips](./issues/04-composite-event-tuples.md) — One event per *logical* phenomenon (priority tuple, service_mode tuple), not per field. Includes previous_event_id for duration.
- [Event row carries full ambient context at transition moment](./issues/05-event-row-ambient-context.md) — Transition + concurrency (raw+weighted+caps) + requests + tokens + cacheHitRate + window anchor. Tests both hypotheses from event rows alone.
- [Coalesced continuous sampling](./issues/06-coalesced-continuous-sampling.md) — Write on every successful poll unless byte-identical to last row. Scales with change rate, not poll rate.
- [Three-tier retention with downsampling](./issues/07-three-tier-retention.md) — Raw samples 7d → daily aggregate forever → events forever. ~10 MB/year footprint.
- [Daily aggregate field set locked](./issues/08-daily-aggregate-fields.md) — Two-snapshot model (trigger-moment + day-total) for all ambient signals incl. concurrency. Two-dimension activity (accumulated hours + UTC span) for bot-detection test.
- [Startup + UTC-midnight downsampling job](./issues/09-downsampling-trigger.md) — Self-healing after downtime. Read path never blocked.
- [day_completeness field for partial/missing days](./issues/10-day-completeness-flag.md) — full/partial_start/partial_end/partial_both/missing/incomplete_window. Pattern view filters/annotates partial days.
- [Configurable gap threshold, default 60min, hot-reloadable](./issues/11-gap-threshold.md) — usage_gap_threshold_minutes. "Not byte-identical" guard separates idle-coalesce from down-proxy.
- [Linked heatmap + timeline visualization](./issues/12-linked-heatmap-timeline.md) — Heatmap for pattern (months/years), timeline for event detail (drill-down). Click day-cell → timeline.
- [Dual-channel heatmap encoding](./issues/13-dual-channel-heatmap.md) — Background = activity density, border = degradation state, border thickness = duration fraction.
- [5 hypothesis-focused timeline lanes](./issues/14-timeline-lanes.md) — Concurrency / Requests / Token flow / Cache hit rate / Degradation state bands. Each lane maps to one hypothesis.
- [Hybrid step-function timeline for old days](./issues/15-old-day-timeline.md) — Dashed step-function between events for days >7d old. Full curves for ≤7d.
- [Brush-to-zoom + preset ranges, 30-day default](./issues/16-heatmap-zoom.md) — Recharts Brush via shadcn Chart. Presets: 7d/30d/90d/1y/all. Click-drag to zoom.

## Not yet specified

- **WS broadcast for new samples/events**: the existing `ws.ts` broadcasts `gate`
  and `usage` messages. Should the Usage tab subscribe to live updates (new
  sample written → cell updates in real-time without refresh)? Likely yes for
  the "real-time" preference, but the message shape and broadcast cadence
  need a decision. Graduates when implementation starts.
- **Event row retention vs. daily aggregate retention**: events are "forever"
  per Q7, but after a year that's a few thousand rows — fine. The question is
  whether very old events (2+ years) should roll up into monthly summaries.
  Premature to decide without seeing actual event volume. Revisit after 6
  months of real data.
- **API route shape**: the existing pattern is `/dashboard/api/usage`,
  `/dashboard/api/economics/*`. New routes will follow
  `/dashboard/api/usage/{samples,daily,events}`. Exact query params (date
  ranges, pagination, filtering by event_kind) need a decision during
  implementation.
- **Config defaults for new knobs**: `usage_raw_retention_days` (default 7),
  `usage_gap_threshold_minutes` (default 60), `usage_history_enabled` (default
  true — allow disabling the whole feature without uninstalling). The
  defaults are settled; the config schema migration (adding to `RawConfig`,
  validation rules, hot-reload allowlist) is an implementation detail.
- **Context.md glossary entries**: `priority tuple`, `service_mode tuple`,
  `Dimension A (accumulated active hours)`, `Dimension B (UTC clock span)`,
  `day_completeness`, `cacheHitRate`. Should be written to `CONTEXT.md` during
  implementation per the domain-modeling skill.

## Out of scope

- **Statistical correlation layer** (Q2 option B): computing "ban probability
  rises with X" automatically. Ship the visual layer first; if the pattern
  is visible, a statistical layer becomes a separate future effort with its
  own map.
- **Auto-detection / mitigation** (Q2 option C): live "looks like automation"
  classifier + action hook back into the gate. Speculative until the
  hypothesis is validated by the visual layer.
- **Multi-account aggregation**: the proxy serves one umans account. Tracking
  multiple accounts' usage patterns is a different product.
- **Export to CSV/external analytics**: the Usage tab is for in-dashboard
  eyeballing. If export is needed later, it's a trivial addition but not
  part of this spec.
- **Alerting/notifications** (e.g., "you've been banned for >2h"): not part of
  the visual-correlation goal. The existing gate panel already shows live
  state.
- **Mobile-responsive layout**: the heatmap + timeline is a desktop-first
  analytics surface. Mobile can be added later if needed.
