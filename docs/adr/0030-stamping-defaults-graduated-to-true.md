# Stamping defaults graduated to true based on benchmark evidence

## Status

Accepted. Supersedes ADR-0016 §2 ("All five stay `false` in
`DEFAULT_CONFIG`") for `stamp_claude_code_enabled` and
`stamp_reasoning_effort_enabled`. ADR-0016 §1 (experimental label
semantics), §3 (not "may be removed"), and §4 (narrow-scope notes) remain
in force.

## Context

ADR-0016 (2026-07-28) established that the `experimental` label is a
humility claim about unmeasured user-visible effects, not a statement
about code maturity. It mandated that all five experimental flags stay
`false` in `DEFAULT_CONFIG` until a benchmark establishes a measured
effect, at which point the flag becomes eligible for graduation via a
new ADR.

On 2026-07-31, commit `cf44d59` flipped
`stamp_claude_code_enabled` and `stamp_reasoning_effort_enabled` from
`false` to `true` in `src/config/defaults.ts` and `src/config/loader.ts`.
The same date, commit `772cc55` flipped the remaining three experimental
flags (`experiment_rewrite_ids`, `experiment_strip_omo_reminder`,
`experiment_ttft_watchdog`) and `use_hard_cap` to `true`. This ADR
addresses the stamping defaults; the experiment flag flips are noted
but governed by their own ADRs (ADR-0026 for TTFT watchdog, ADR-0006
for the stamp catalog).

### Benchmark evidence

`docs/BENCHMARKS.md` (section "Stamp bundle effect on KV-cache hit
rates", run date 2026-07-31) measured the stamp bundle effect across
three models on both Anthropic and OpenAI routes:

| Model | Best route | Experiments | Hit % | Mean TTFT (ms) | Mean TPS |
|---|---|---|---|---|---|
| umans-coder | openai | OFF | 99.53 | 1942 | 72.54 |
| umans-flash | openai | ON | 89.82 | 1265 | 157.19 |
| umans-glm-5.2 | anthropic | OFF | 98.37 | 4427 | 56.98 |

**Key findings:**

- `umans-flash` benefits decisively from the stamp bundle: +40.46 pp
  hit rate, −62 % TTFT, +93.3 TPS on the OpenAI route. The stamp
  bundle's TTL + thinking-shape stabilization appears essential for
  Qwen-family prefix caching on the OpenAI path.
- `umans-coder` (kimi) regresses with stamping on both routes: hit rate
  drops 10–16 pp, TPS falls 10–18 tokens/s. Kimi's upstream auto-cache
  is already strong; the added body mutation destabilizes the prefix.
- `umans-glm-5.2` regresses with stamping on both routes: hit rate drops
  ~10 pp, TPS falls ~18 tokens/s. On the OpenAI route, Pass B was
  unstable (4/10 turns completed).

The evidence is mixed, not universally positive. ADR-0016's graduation
path required "a benchmark establishing a measured effect" — the
benchmark exists and the effect is measured, but it is model-specific.

### Per-model escape hatch

ADR-0029 (per-model stamp rules table) provides `stamp_model_rules[]`
with `openai_veto_reasoning_effort` and per-model stamp overlays. Users
running models that regress (umans-coder, umans-glm-5.2) can veto
stamping per-model without disabling it globally.

## Decision

1. **`stamp_claude_code_enabled` and `stamp_reasoning_effort_enabled`
   default to `true` in `DEFAULT_CONFIG`.** The benchmark establishes a
   measured, decisive benefit for `umans-flash` — the primary
   single-model use case the maintainer built the stamp bundle for. The
   mixed results for other models are addressed by per-model veto
   (ADR-0029), not by keeping the global default off.

2. **ADR-0016 §2 is superseded for these two flags.** The graduation
   path in ADR-0016 §4 (line 77–80) is satisfied: a benchmark exists in
   `docs/BENCHMARKS.md`, the effect is measured, and this ADR documents
   the graduation.

3. **The `experimental` label (ADR-0016 §1) is retained.** The label
   tracks the evidence level for the user-visible benefit. The benchmark
   measured the effect for one model and showed regression for two
   others. The benefit is not universal; the label correctly signals
   "measured for some, not all." Removing the label would over-claim
   universality.

4. **The remaining three experimental flags** (`experiment_rewrite_ids`,
   `experiment_strip_omo_reminder`, `experiment_ttft_watchdog`) were
   also flipped to `true` by commit `772cc55`. Their graduation is
   noted here for chronological context but governed by their own ADRs
   (ADR-0026 for TTFT watchdog). This ADR does not supersede ADR-0016
   for those three flags; a separate measurement or product rationale
   should be documented if challenged.

## Consequences

- Fresh installs get stamping on by default. Existing installs without
  an explicit config value are flipped on first run; the proxy emits a
  console banner (commit `cf44d59`) when stamping flips implicitly.
- Users running `umans-coder` or `umans-glm-5.2` should add per-model
  veto rules (ADR-0029) to avoid the measured regression. The README
  and `docs/proxy-modifications.md` document this escape hatch.
- The `experimental` Beaker badge remains on both config fields. It now
  means "measured for some models, not universally beneficial" rather
  than "felt, not measured."
- A future universal benchmark (all models benefiting) would be the path
  to removing the `experimental` label entirely.
- ADR-0016 §2 ("All five stay `false`") is no longer accurate for any of
  the five flags. ADR-0016 §1, §3, §4 remain governing.
