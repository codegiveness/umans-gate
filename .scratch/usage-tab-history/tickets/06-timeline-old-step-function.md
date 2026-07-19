# 06 — Timeline (old days): hybrid step-function from events + daily

**What to build:** The per-day timeline for days >7 days old (raw samples pruned). The same 5-lane timeline from ticket 05, but with a different data source: event markers plotted at exact timestamps with their recorded ambient context, and dashed step-function segments between events (held-constant from the prior event's ambient context, or daily aggregate peak/avg if no events fired that day). Degradation bands span from real onset to real resolution timestamps (accurate, not interpolated). The dashed convention signals "held-constant, not observed" so the user doesn't misread held-constant segments as real observed curves. This slice preserves the drill-down workflow for historical days — you can still click a 30-day-old heatmap cell and see the shape of that day with accurate ban durations, even though raw samples are gone.

**Blocked by:** 05 — Timeline recent (extends the same timeline view with the old-day data source)

**Status:** ready-for-agent

- [ ] Timeline detects day age: if `day_age > usage_raw_retention_days`, use the hybrid data source; otherwise use raw samples (ticket 05 behavior).
- [ ] Event markers plotted at exact `fetched_at` timestamps from `/dashboard/api/usage/events?from=&to=` for that day. Each marker carries the event's recorded ambient context.
- [ ] Between events: lanes render as step-functions using the prior event's ambient context (or daily aggregate peak/avg if no prior event). Step rendered via Recharts `Line` with `step` prop.
- [ ] Held-constant segments rendered with `strokeDasharray` (dashed line) — visually distinct from solid curves in ticket 05. Standard convention for "data sampled at events, not continuously."
- [ ] Degradation bands (Lane 5) span from real onset timestamp to real resolution timestamp — accurate, not interpolated. Same `ReferenceArea` primitive as ticket 05.
- [ ] At each event marker, lane values jump to the event's recorded ambient context (step-function jump). The jump is visible as a step in the dashed line.
- [ ] If a day has zero events: lanes render as a single dashed flat line at the daily aggregate's peak/avg values for that day. `day_completeness` flag visible somewhere in the timeline UI (e.g., a badge or note) so the user knows whether the flat line is "no activity" or "incomplete data."
- [ ] Integration test — drive mock upstream through a day with events; trigger downsampling to prune raw samples; fetch timeline for that day via API (or via dashboard component test); assert event markers present at correct timestamps; assert dashed step-function between events; assert degradation bands span correct onset→resolution range.
- [ ] shadcn constraint respected.
- [ ] `bun run typecheck` passes; `bun run lint` clean; no type suppressions.
