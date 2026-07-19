# 15 — Hybrid step-function timeline for old days

Type: grilling
Status: resolved
Blocked by: (none)

## Question

What does the timeline show for days older than 7 days (raw samples pruned)?

## Answer

**Hybrid: event markers at exact times (with ambient context curves *between
events only*).**

When raw samples are gone, plot the event rows as markers at their exact
timestamps. *Between* events, draw the lane as a flat line using the
*previous event's ambient context* (or the daily aggregate if no events
fired). At each event marker, the lane value jumps to the event's recorded
ambient context. Degradation bands span from onset to resolution event
timestamps.

The step-function segments are visually distinct from real observed curves:
**dashed line** for "held constant, not observed" vs solid line for real
samples. Standard convention for "data sampled at events, not continuously"
(how financial tick charts work between trades).

### Rationale

- **A (flat-line baseline with event markers)** is actively misleading. A
  user seeing a flat concurrency line at 8 would reasonably conclude
  "concurrency was 8 all day" — false. The dashed-step encoding signals
  "held-constant, not observed" — no misread risk.
- **B (no high-res data + daily summary card + event table)** discards the
  visual entirely. The degradation bands are the most important visual signal
  on the timeline — they show "you were banned from 14:00 to 22:00."
  Replacing with a table row loses the at-a-glance gestalt.
- **D (extend raw retention to 30 days)** solves the problem by spending 4×
  storage on a rare access path. User said "real-time, light, fast" — 4×
  storage for a drill-down rarely accessed (most pattern analysis happens on
  the heatmap) is the wrong trade.

C is honest *and* visual. The step-function with dashed segments signals
"this is held-constant, not observed" — no misreading. Event markers carry
full ambient context. Degradation bands are accurate (real onset → real
resolution). The event rows (per Q5) carry full ambient context at onset
*and* at resolution — so the step function has real data points at both ends
of every ban, not just the onset. Between a resolution and the next onset,
the daily aggregate's peak/avg provides a reasonable "typical value for that
day" for the held-constant segments.

### UI primitives

Recharts supports step-functions via the `step` prop on `Line` components,
and dashed lines via `strokeDasharray`. Degradation bands via `ReferenceArea`.
No non-shadcn primitives needed.
