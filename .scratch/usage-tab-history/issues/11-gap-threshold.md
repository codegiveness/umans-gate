# 11 — Configurable gap threshold, default 60min, hot-reloadable

Type: grilling
Status: resolved
Blocked by: (none)

## Question

What is the gap-detection threshold for `incomplete_window`?

## Answer

**Configurable, default 60 minutes, hot-reloadable.** Config knob:
`usage_gap_threshold_minutes`.

### Detection logic

A gap counts as "incomplete" only when:
- `next_sample.fetchedAt − prev_sample.fetchedAt > usage_gap_threshold_minutes`
  **AND**
- `next_sample` is *not byte-identical* to `prev_sample` (i.e., something
  actually changed, implying the proxy missed the transition)

If the two rows are byte-identical, the gap is idle coalescing (per Q6/C) —
not incompleteness.

### Rationale

- Default 60min matches the existing `usage_refresh_ms` default (60s) × 60
  polls = one hour of missing polls. A 60min gap with non-identical adjacent
  rows is a strong signal the proxy was actually down, not just idle.
  Aligns with the natural "lunch break" boundary.
- The "not byte-identical" guard is the real precision mechanism — it cleanly
  separates idle-coalesce gaps from down-proxy gaps regardless of threshold.
  The threshold is just a magnitude filter on top of that guard.
- **Hot-reloadable** so the user can tune it without restart. If real data
  shows 60min too aggressive (false positives) or too lenient (misses 45min
  crashes), tune without restart. Consistent with the codebase's existing
  hot-reloadable config pattern (`breaker_*`, `rate_limit_*`,
  `stamp_claude_code_enabled`).
- **A (30min)** is too aggressive given coalesce behavior: during light
  activity with infrequent changes, 30min gaps between *non-identical* rows
  can happen legitimately (e.g., one request every 30min overnight). False
  positives pollute the `incomplete_window` flag's signal.
- **D (adaptive: 3× median poll interval for that day)** is elegant but
  over-engineered for a user-scale app. The median computation adds SQL
  complexity, and the "not byte-identical" guard already handles the coalesce
  case. If `usage_refresh_ms` is tuned down, `usage_gap_threshold_minutes`
  can be tuned down proportionally — same effect, simpler.

### Config

| Knob | Default | Min | Hot-reloadable | Validation |
|---|---|---|---|---|
| `usage_gap_threshold_minutes` | 60 | 5 | yes | integer ≥ 5 |
