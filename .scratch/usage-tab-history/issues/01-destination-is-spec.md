# 01 — Destination is a spec, not shipped code

Type: grilling
Status: resolved
Blocked by: (none)

## Question

What is "done" for this wayfinder effort? Three options were surfaced:

- **A** — A spec for the Usage tab (decisions handed off to implement)
- **B** — Shipped Usage tab (execution carried into the map)
- **C** — Validated hypothesis report (research finding)

## Answer

**A.** The map delivers decisions on schema, cadence, retention, and
visualization. Implementation is a separate, well-bounded effort once the
spec is locked.

### Rationale

- Wayfinder is plan-don't-do by default: produce decisions, hand off the build.
- The hypothesis is still fog (thresholds unpublished, "all just suspicion").
  Building before deciding what to sample and how to correlate risks logging
  the wrong fields and re-schema-ing.
- The spec encodes the real decisions: sample schema, polling cadence, UTC 24h
  grid visualization, ban-event logging, correlation method.
