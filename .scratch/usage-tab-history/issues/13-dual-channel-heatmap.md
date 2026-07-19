# 13 — Dual-channel heatmap encoding

Type: grilling
Status: resolved
Blocked by: (none)

## Question

What does the heatmap cell color encode?

## Answer

**Dual channel: background = activity density, border = degradation state.**

- **Cell background color intensity** = `active_minutes` in that UTC hour
  (none/pale/dark, 4–5 intensity steps). Answers "was I active?"
- **Cell border color** = degradation state in that hour:
  - no border = normal
  - yellow border = priority-low active
  - orange border = boxed
  - red border = service_mode non-normal
- **Border thickness** = duration fraction (thicker = more of the hour was
  degraded).

A cell with dark background + red thick border = "working hard and got
banned." A cell with pale background + red border = "barely active and still
got banned" — the anomaly the hypothesis predicts (low activity + still
degraded = umans flagged on Dimension B / UTC span, or on cumulative token
volume, not on concurrent activity).

### Rationale

The hypothesis is specifically about the *correlation* between activity
pattern and degradation. Both signals must be equally visible — neither can
be a secondary opacity nor an overlay dot easy to miss at scale.

The border/fill split is the cleanest dual-channel encoding for a cell-based
heatmap. Background fill (continuous) carries activity density; border
(categorical, 4 states) carries degradation state. The eye parses both in
parallel without competition.

Border thickness as a duration fraction is a subtle but powerful detail:
"red border, thin" = brief ban in that hour; "red border, thick" = banned for
most of the hour. Lets you scan the heatmap and see *both* when bans happened
and how long they lasted — without clicking through to the timeline for
every event.

- **A (single channel: activity density, ban onsets as overlay dots)** loses
  degradation *duration* visibility on the heatmap — only onset is visible.
- **B (single channel: degradation severity, activity as opacity)** inverts
  the priority — activity becomes secondary, but for the hypothesis activity
  context must be equally visible.
- **D (triple channel: activity + priority + service_mode)** is chartjunk.
  The two degradation signals can share one border channel because they're
  correlated (priority box often precedes service_mode ban) and when they
  co-occur, the more severe state (service_mode) wins the border color
  naturally.
