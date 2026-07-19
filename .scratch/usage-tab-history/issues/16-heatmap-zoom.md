# 16 — Brush-to-zoom + preset ranges, 30-day default

Type: grilling
Status: resolved
Blocked by: (none)

## Question

Time-range selector for the heatmap + default view on tab open.

## Answer

**Default: last 30 days. Zoom: preset ranges (7d / 30d / 90d / 1y / all) +
brush-to-zoom on the heatmap itself (click-drag a date range to zoom in).
Double-click to reset.**

### Interaction

- On tab open: heatmap shows last 30 days. Enough to see a pattern forming,
  not so much it's overwhelming.
- Preset dropdown (shadcn `Select` or `DropdownMenu`): 7d / 30d / 90d / 1y /
  all.
- Brush-to-zoom: click-drag a date range on the heatmap → zooms to that
  range at full resolution. Double-click resets to the preset.
- The brush uses Recharts's `Brush` component, which comes in through
  shadcn's `Chart` wrapper. Not a separate non-shadcn library.

### Rationale

The brush-to-zoom is the natural interaction for a heatmap: you see a
suspicious cluster of red-bordered cells at UTC 03:00 across July 10–15 →
click-drag that date range → heatmap zooms to those 6 days at full
resolution. This is the pattern-finding workflow made fluid.

30-day default balances two needs: enough data to see a pattern (a week is
too short — can't see "do bans cluster in my off-hours?" from 7 days), but
not so much that the heatmap is a wall of cells (90 days = 2,160 cells —
readable but dense).

- **A (preset-only zoom)** forces the question to fit available ranges. If
  the suspicious cluster spans July 10–15, you'd zoom to "30d" and visually
  filter.
- **B (free-form date pickers)** works but is slower than brush-to-zoom for
  the common case. Date pickers are better for *exact* ranges, which is rarer.
- **D (month pagination)** is a different mental model — calendar-based, not
  pattern-based. A pattern spanning July 25–Aug 5 is split across two pages.
  The heatmap's strength is showing continuous time; pagination fights that.

### UI primitives

- shadcn `Select` or `DropdownMenu` for presets
- Recharts `Brush` (via shadcn `Chart`) for brush-to-zoom
- shadcn `Button` for reset

No non-shadcn visual component needed. Recharts is the rendering engine
shadcn's `Chart` is built on — treated as "available on shadcn" per user
constraint (Q11).
