# 02 — Visual correlation only, no statistical layer

Type: grilling
Status: resolved
Blocked by: (none)

## Question

What does "learn the pattern" mean? Three options:

- **A** — Visual correlation (human eyeballs UTC 24h grid)
- **B** — Statistical correlation (system computes "ban probability rises with X")
- **C** — Auto-detection / mitigation (live classifier + action hook)

## Answer

**A.** The spec delivers time-series storage + a heatmap/timeline tab. No
statistical logic, no mitigation layer.

### Rationale

- The hypothesis is still fog. Before building statistical or mitigation
  layers, raw history is needed to see whether the signal exists. Viz-first
  lets a human falsify or reinforce the hypothesis cheapest.
- B requires deciding which correlation metric to compute before the data
  shape is seen — premature. Once A is shipped and a few weeks of history
  exist, B becomes a well-bounded follow-up effort.
- C is a feature on top of a confirmed hypothesis; building it before
  validation is speculative.
