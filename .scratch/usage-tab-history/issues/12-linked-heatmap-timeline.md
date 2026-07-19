# 12 — Linked heatmap + timeline visualization

Type: grilling
Status: resolved
Blocked by: (none)

## Question

Visualization primitive for the Usage tab.

## Answer

**Both, linked.** Heatmap as the primary view (months/years, the pattern-
finding surface). Click a day-cell → opens a timeline for that day (raw
samples if ≤7 days old, or hybrid step-function for older — see ticket 15).
Ban onsets on the heatmap are clickable → jump to that event's moment in the
timeline.

### UI constraint (user-stated)

"Use full shadcn as possible. If not available on shadcn, ask me first for
using other alternatives."

- shadcn/ui doesn't ship a heatmap component directly. Heatmap cells are
  plain `<div>` elements with Tailwind classes (`bg-green-500`,
  `border-2 border-red-500`, etc.). This is fully shadcn-idiomatic — shadcn
  is Tailwind-based and builds cards/badges the same way. No non-shadcn
  component needed.
- Timeline uses shadcn's `Chart` component (built on Recharts). Recharts
  supports stacked areas, lines, reference lines, reference areas — all
  needed primitives. Recharts-via-shadcn is treated as "available on shadcn"
  (it's the rendering engine shadcn's charts are built on, already a
  dependency).

### Rationale

The hypothesis has two scales: long-term pattern (weeks/months — "do bans
cluster in my off-hours over time?") and event-level detail ("what was the
cache hit rate when the service_mode ban fired on July 15?"). No single
primitive serves both. A heatmap finds the pattern; a timeline explains the
event.

The link between them is the key UX: see a suspicious cluster of red dots
on the heatmap at UTC 03:00 across multiple days → click one → timeline
opens showing exactly what concurrency/tokens/requests looked like at that
moment. This is the "visual correlation" workflow (Q2/A) made concrete.

- **A (heatmap only)** loses event-level detail — "what was concurrency when
  the ban fired?" requires a drill-down.
- **B (timeline only)** doesn't scale — a 90-day timeline is unreadable.
- **D (calendar view, GitHub-contributions-style)** puts the hour-dimension
  behind a drill-down. The hypothesis is specifically about *which UTC hours*
  — the hour dimension needs to be visible at a glance, not hidden behind a
  click.
