# 14 — 5 hypothesis-focused timeline lanes

Type: grilling
Status: resolved
Blocked by: (none)

## Question

Which signals get their own lane in the per-day timeline drill-down?

## Answer

**5 lanes, each mapping to one hypothesis:**

1. **Concurrency** — raw + weighted concurrent sessions as two lines +
   horizontal `concurrencyHardCap` reference line. *Tests: did I hit the hard
   cap?*
2. **Requests** — `requestsInWindow` as area + `requestsLimit` line +
   `requestsRemaining` as fading overlay. *Tests: did I exhaust the request
   window?*
3. **Token flow** — tokens in / out / cached as stacked areas. *Shows volume
   + composition.*
4. **Cache hit rate** — line, 0–100%, with a horizontal threshold marker at
   the historical average (computed from `usage_daily.cache_hit_rate_avg`
   across prior 30 days). *Tests: did cache hit rate drop before the
   service_mode ban?*
5. **Degradation state** — priority state (normal/priority-low/boxed/demoted)
   + service_mode (normal/non-normal) as colored horizontal bands spanning
   the full width, with ban-onset vertical lines crossing all lanes above.
   *The event markers that tie it all together.*

### Rationale

Each lane maps *directly* to one of the stated hypotheses: lane 1 = hard-cap
theory, lanes 3+4 = token-volume + cache-hit-rate theory, lane 2 =
request-count theory. The lane *is* the hypothesis.

5 lanes is the sweet spot: fits a screen, covers every signal the hypotheses
name. The degradation state as full-width bands (lane 5) with vertical onset
lines crossing all lanes above is the key UX: when a ban fires, the eye
instantly traces the vertical line upward to see what concurrency / requests
/ tokens / cache hit rate looked like at that exact moment. This is the
"visual correlation" workflow (Q2/A) made literal.

The `cache hit rate` lane with a horizontal "historical average" marker is a
small but important detail: it gives a baseline to compare against at
ban-onset. "Cache hit rate was 45% when the ban fired, vs my average of 68%"
is a stronger signal than "cache hit rate was 45%" in isolation.

- **A (minimal 4 lanes)** hides cache hit rate inside token-flow mental math
  — but the service_mode theory explicitly names cache hit rate as a
  suspected trigger.
- **B (full 7 lanes)** over-fragments: splitting raw and weighted concurrency,
  and splitting cached tokens from in/out, adds vertical space without adding
  analytical power.
- **D (single combined chart with multi-axis)** is a known anti-pattern for
  correlation analysis. Multi-axis charts hide correlation by forcing the eye
  to disambiguate which scale a curve belongs to.

### UI primitives

shadcn/ui `Chart` component (built on Recharts) supports:
- Stacked areas (lanes 1, 2, 3)
- Lines with reference lines (lanes 1, 4)
- Reference areas for degradation bands (lane 5)
- Vertical reference lines for ban onsets (cross-lane)

All 5 lanes buildable with shadcn chart primitives. No non-shadcn component
needed.
