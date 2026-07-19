# 04 — Composite event tuples, not per-field flips

Type: grilling
Status: resolved
Blocked by: (none)

## Question

Which field-flips count as "degradation events" worth logging?

## Answer

**Two composite events:**

1. **`priority` state** = `{priorityLow, boxedUntil, boxedReason, unitsDemoted,
   demotedUntil}` as a single tuple. Logged when *any* element of the tuple
   changes.
2. **`service_mode` state** = `{current, resetsAt}` as a single tuple. Logged
   when either element changes.

Each event row carries a `transition` field: `"onset"` | `"resolved"` |
`"morph"` (tuple changed but didn't cross all-clear boundary, e.g.
`boxedUntil` extended).

Each event row also carries `previous_event_id` linking to the row for the
prior state of this kind, so ban duration (`resolved_at − onset_at`) is
computable in pure SQL.

### Rationale

The hypothesis treats "priority box" and "service_mode ban" as two
*phenomena*, not five separate fields. One event per phenomenon-transition,
not one per field-flip.

Per-field flips (option B) create noise: `priorityLow` and `boxedUntil`
usually pop together, producing two events at the same timestamp for the
same underlying state change.

Minimal (option A, priorityLow + serviceMode.current only) loses
`unitsDemoted`, `boxedReason`, `boxedUntil` — which are part of the priority
phenomenon (how long boxed, why). Folding them into a composite tuple
preserves them without duplicating events.

Resolution events fire on the same trigger, so ban *duration* falls out
naturally: `resolved_at − onset_at` per event.
