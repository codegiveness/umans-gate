# 04 — Heatmap: dual-channel viz, range selector, brush-to-zoom

**What to build:** The heatmap as the primary view of the Usage tab. UTC day × UTC hour grid (24 columns × N days). Cell background color intensity = activity density (4–5 steps from `active_minutes_by_utc_hour` in the daily aggregate). Cell border color = degradation state in that hour (no border = normal, yellow = priority-low active, orange = boxed, red = service_mode non-normal). Border thickness = duration fraction (how much of that hour was degraded). Preset range selector (7d / 30d / 90d / 1y / all, default 30d) via shadcn `Select` or `DropdownMenu`. Brush-to-zoom (click-drag a date range to zoom in, double-click to reset) via Recharts `Brush` through shadcn `Chart`. A cell with pale background + red border (the "low activity + still degraded" anomaly the user's hypothesis predicts) is visually distinctive. This slice turns the Usage tab from a raw list into a pattern-finding surface.

**Blocked by:** 02 — Events (events API for degradation border state per hour), 03 — Daily aggregate (daily API for activity density background)

**Status:** ready-for-agent

- [ ] Heatmap renders UTC day × UTC hour grid. Plain `<div>` cells with Tailwind classes for background intensity + border color/thickness. No external heatmap library (shadcn-idiomatic).
- [ ] Cell background: 4–5 intensity steps derived from `active_minutes_by_utc_hour` bucket value for that day+hour. None/pale/medium/dark.
- [ ] Cell border: no border (normal), yellow (priority-low), orange (boxed), red (service_mode non-normal). Thickness = duration fraction (3 steps: thin < 15min, medium 15–45min, thick > 45min).
- [ ] Degradation state per hour computed by joining `usage_events` (onset/resolution timestamps falling within that hour) for days where daily aggregate exists, OR by scanning `usage_samples` for recent days where raw samples are still present.
- [ ] Preset range selector (shadcn `Select` or `DropdownMenu`): 7d / 30d / 90d / 1y / all. Default 30d on tab open.
- [ ] Brush-to-zoom: click-drag a date range on the heatmap → zooms to that range. Double-click resets to preset. Uses Recharts `Brush` via shadcn `Chart` wrapper (not a separate library — Recharts is the rendering engine shadcn's Chart is built on).
- [ ] The pale-background + red-border anomaly cell is visually distinctive — verify by rendering a test scenario with low activity + a service_mode ban in the same hour.
- [ ] Dashboard component test — mock the samples/events/daily API responses; assert heatmap renders correct number of cells; assert a cell with a service_mode event has a red border; assert brush interaction triggers range change.
- [ ] shadcn constraint respected: if any non-shadcn component is needed, ask the user first before substituting (hard constraint from spec, not a preference).
- [ ] `bun run typecheck` passes; `bun run lint` clean; no type suppressions.
