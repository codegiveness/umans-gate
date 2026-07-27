# "Experimental" labels a humility claim, not code immaturity

## Status

Accepted. Governs all `FieldDef.experimental: true` flags in
`dashboard/src/components/config-sections.ts` and the `experiment_*` /
`stamp_*_enabled` defaults in `src/config/defaults.ts:6`.

## Context

umans-gate labels five config fields as `experimental`
(`config-sections.ts:45`, rendered as a Beaker icon at
`config-fields.tsx:281`): `stamp_claude_code_enabled`,
`stamp_reasoning_effort_enabled`, `experiment_rewrite_ids`,
`experiment_ttft_watchdog`, and `experiment_strip_omo_reminder`. All
five default to `false` in `DEFAULT_CONFIG` (`defaults.ts:6`). Four are
backed by production-grade code and dedicated ADRs (ADR-0004 for TTFT,
ADR-0006 for the stamp catalog, ADR-0008 for respect-if-present
stamping, ADR-0011 for adaptive thinking). The `ConcurrencyGate`
(`src/limiter/gate.ts:392`) has 41 callers and full test coverage.

By conventional software-engineering definitions, most of these features
are not experimental; they are load-bearing and documented. A future
contributor could reasonably conclude the `experimental` flag is
misapplied, remove it, or flip defaults to `true` to "promote" the
features.

## Decision

The `experimental` label in umans-gate is a humility claim about
unmeasured user-visible effects, not a statement about code quality or
maturity.

The maintainer's observed benefits (higher cache hit rate, lower
frustration during upstream degradation, faster TTFT) are anecdotal,
felt when comparing direct upstream API usage against proxied usage.
They have not been benchmarked, A/B tested, or measured against a
control. The label refuses to over-claim these effects to users who
might otherwise flip the defaults on expecting guaranteed improvements.

Concretely:

1. All five flags stay labeled `experimental`. The ADR backing or
   caller count of a feature does not graduate it out of the label;
   the label tracks the *evidence level for the user-visible benefit*,
   not the code's production-readiness.

2. All five stay `false` in `DEFAULT_CONFIG`. A humility-labeled
   feature is opt-in by definition. Flipping a default to `true` would
   assert the benefit by default, contradicting the humility claim.

3. The label does not mean "may be removed." ADR-backed experimental
   features (TTFT watchdog, stamp pipeline) have stable contracts.
   The label means "the maintainer will not assert you will experience
   the intended benefit," not "this feature is provisional."

4. `experiment_strip_omo_reminder` is the narrowest case. It is
   both humility-labeled *and* opencode-specific (single-consumer
   workaround for oh-my-openagent's reminder injection). Its
   experimental status carries the additional meaning of "narrowly
   scoped to one harness," but it is not *more* experimental than the
   others in the humility sense.

## Consequences

- Future contributors must not remove the `experimental` flag from a
  field to "promote" it, nor flip its default to `true`, without
  introducing measured evidence of the user-visible benefit. A new ADR
  documenting the measurement is the graduation path.
- The `FieldDef.experimental` badge (`config-fields.tsx:281`) is the
  user-facing surface of this semantics. Its Beaker icon should be read
  as "felt, not measured," not "prototype."
- This ADR does not block recommending the features to users; it
  blocks asserting their benefits as fact. The README §1 already
  describes what stamping does; it does not promise cache-hit-rate
  improvements, and that restraint is correct.
- If a future benchmark (e.g., a `docs/BENCHMARKS.md` entry comparing
  proxied vs. direct cache hit rate) establishes a measured effect, the
  corresponding flag becomes eligible for label removal and default
  flip via a new ADR superseding this one.
