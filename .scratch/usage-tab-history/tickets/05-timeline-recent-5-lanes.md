# 05 — Timeline (recent days): 5-lane drill-down from raw samples

**What to build:** The per-day timeline drill-down for days ≤7 days old. Clicking a heatmap day-cell opens a 5-lane timeline view for that UTC day. Each lane maps to one hypothesis: (1) Concurrency — raw + weighted concurrent sessions as two lines + horizontal `concurrencyHardCap` reference line; (2) Requests — `requestsInWindow` as area + `requestsLimit` line + `requestsRemaining` as fading overlay; (3) Token flow — tokens in / out / cached as stacked areas; (4) Cache hit rate — line 0–100% with horizontal threshold marker at the 30-day historical average (computed from `usage_daily.cache_hit_rate_avg` across prior 30 days); (5) Degradation state — priority state + service_mode as colored horizontal bands spanning full width. Ban-onset vertical lines cross all lanes above so the eye traces from "ban fired here" upward to "what was concurrency / requests / tokens / cache hit rate at that exact moment?" All curves are solid (real observed data from raw samples). This slice makes the "visual correlation" workflow concrete: see a suspicious heatmap cell → click → see exactly what was happening when the ban fired.

**Blocked by:** 04 — Heatmap (timeline opens on day-cell click; this is the drill-down path), 01 — Raw samples (samples API provides the curves; transitively satisfied by the time 05 starts but listed for clarity)

**Status:** ready-for-agent

- [ ] Clicking a heatmap day-cell opens the timeline view for that UTC day. Back/return navigation returns to the heatmap at the previous zoom level.
- [ ] 5 lanes render via shadcn `Chart` (built on Recharts): `Line`, `Area`, `ReferenceLine`, `ReferenceArea` primitives. No new charting library.
- [ ] Lane 1 — Concurrency: raw + weighted as two `Line`s, `concurrencyHardCap` as horizontal `ReferenceLine`.
- [ ] Lane 2 — Requests: `requestsInWindow` as `Area`, `requestsLimit` as `ReferenceLine`, `requestsRemaining` as fading overlay (Area with reduced opacity).
- [ ] Lane 3 — Token flow: tokens in / out / cached as stacked `Area`s.
- [ ] Lane 4 — Cache hit rate: `Line` 0–100%, horizontal `ReferenceLine` at 30-day historical average (from `usage_daily.cache_hit_rate_avg`).
- [ ] Lane 5 — Degradation state: `ReferenceArea` bands spanning full width, colored by priority state (normal/priority-low/boxed/demoted) and service_mode (normal/non-normal).
- [ ] Ban-onset vertical `ReferenceLine`s cross all lanes above (vertical line at each event timestamp from the events API for that day).
- [ ] All curves solid (real observed data from `/dashboard/api/usage/samples?date=`).
- [ ] Dashboard component test — mock samples + events API for a test day with a ban onset; assert 5 lanes render; assert ban-onset vertical line crosses all lanes; assert hard_cap reference line is visible.
- [ ] shadcn constraint respected.
- [ ] `bun run typecheck` passes; `bun run lint` clean; no type suppressions.
