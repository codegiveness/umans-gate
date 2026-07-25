# Model-specific thinking block shapes

Status: Accepted
Date: 2026-07-25

## Context

ADR-0011 forced every non-disabled `thinking` block to `{ type: "adaptive" }`
on the Anthropic/Claude-Code stamp path, regardless of model family. That
shape works for the proxy's adaptive-thinking models (`umans-flash`,
`umans-qwen*`, and the fallback `*` policy), but it leaves two model
families on the table:

### GLM Preserved Thinking (Z.ai)

The Z.ai thinking-mode documentation
(https://docs.z.ai/guides/capabilities/thinking-mode) documents a
`clear_thinking` field on the `thinking` block:

> This capability [Preserved Thinking] is enabled by default on the
> Coding Plan endpoint and disabled by default on the standard API
> endpoint. If you want to enable Preserved Thinking in your product
> (primarily recommended for coding/agent scenarios), you can turn it
> on for the API endpoint by setting `"clear_thinking": false`, and you
> must return the complete, unmodified `reasoning_content` back to the
> API.

The standard API endpoint (which `umans-gate` forwards to) defaults to
`clear_thinking: true`, clearing prior `reasoning_content` across turns.
For coding/agent scenarios — exactly the workload this proxy serves —
Preserved Thinking must be explicitly enabled with
`thinking: { type: "enabled", clear_thinking: false }`.

Forcing `{ type: "adaptive" }` on `umans-glm*` requests drops the
`clear_thinking: false` signal entirely, so the proxy was silently
running GLM models without Preserved Thinking even though the
upstream supports it and the workload benefits from it.

### Kimi Preserved Thinking (Moonshot)

The Kimi thinking-models documentation
(https://platform.kimi.ai/docs/guide/use-thinking-models) documents a
`keep` field on the `thinking` block:

> `kimi-k2.6`: `thinking.keep` — `null` (default, not kept) / `"all"`
> (enables Preserved Thinking).
>
> `kimi-k2.7-code`: Preserved Thinking is always on and cannot be turned
> off — `thinking.keep` is treated as `"all"` whether omitted or set to
> `"all"`.

`umans-kimi*` and `umans-coder` (both Kimi K2.7-Code base) benefit from
Preserved Thinking. Forcing `{ type: "adaptive" }` on these models drops
the `keep: "all"` signal, so the proxy was running them without
Preserved Thinking on the standard endpoint even though the upstream
expects it for coding scenarios.

## Decision

Widen `ThinkingConfig` from a single `{ type: "adaptive" }` interface to
a discriminated union supporting three shapes:

```typescript
type ThinkingConfig =
  | { type: "adaptive" }
  | { type: "enabled"; keep: "all"; budget_tokens: number }
  | { type: "enabled"; clear_thinking: boolean; budget_tokens: number };
```

Add a per-family `thinkingShape: ThinkingConfig` field to `StampPolicy`
in `stamp-catalog.ts`. Each `STAMP_OVERLAY` entry declares the shape
its model family forces:

| Pattern | `thinkingShape` | Source |
|---|---|---|
| `umans-glm*` | `{ type: "enabled", clear_thinking: false, budget_tokens: 32000 }` | Z.ai Preserved Thinking |
| `umans-coder` | `{ type: "enabled", keep: "all", budget_tokens: 32000 }` | Kimi Preserved Thinking |
| `umans-kimi*` | `{ type: "enabled", keep: "all", budget_tokens: 32000 }` | Kimi Preserved Thinking |
| `umans-flash` | `{ type: "adaptive" }` | legacy adaptive |
| `umans-qwen*` | `{ type: "adaptive" }` | legacy adaptive |
| `*` (fallback) | `{ type: "adaptive" }` | legacy adaptive |

`stampThinking()` in `stamp-thinking.ts` now forces `body.thinking` to
`policy.thinkingShape` (instead of the hardcoded
`STAMP_THINKING_VALUE` constant) when the forcing path fires — i.e.
when `options.thinking` is true, `body.thinking` is present, and the
block is either non-disabled or disabled-but-`canDisableThinking: false`.

A structural `thinkingEquals()` helper compares the current
`body.thinking` against `policy.thinkingShape` so the step skips the
write (no spurious `changed = true`) when the body already carries the
policy's shape.

The `budget_tokens: 32000` value matches the Kimi docs' recommendation
(`max_tokens >= 16000` for the full `reasoning_content` + `content`) and
Z.ai's coding-scenario guidance, while staying within the
`max_tokens: 32767` envelope the proxy stamps for non-GLM models. GLM
gets `131071` for `max_tokens` (its overlay value), so
`budget_tokens: 32000` is well within budget.

Disabled thinking blocks remain respected per `policy.canDisableThinking`
(ADR-0011). Only the forced *target* shape changes — the gating logic
is untouched.

## Consequences

- `ThinkingConfig` is now a discriminated union. Every site that
  constructs a `ThinkingConfig` must pick a variant. The
  `STAMP_THINKING_VALUE` constant in `config/constants.ts` stays
  `{ type: "adaptive" }` and remains exported, but is no longer
  consumed by `stampThinking()` (the per-family `thinkingShape` replaces
  it). It is retained for external consumers and backward compatibility.
- `StampPolicy` gains a required `thinkingShape` field. All `STAMP_OVERLAY`
  entries, `parseModelInfoResponse` (which spreads `matchStampOverlay`),
  and every test that constructs a `StampPolicy` via `toEqual` must
  include the field.
- `stampThinking()` no longer imports `STAMP_THINKING_VALUE`; it reads
  `policy.thinkingShape` instead. The forcing path writes a shallow copy
  (`{ ...policy.thinkingShape }`) so the policy's shape object is not
  aliased into the request body.
- The `thinkingEquals()` helper is private to `stamp-thinking.ts` — it
  compares only the discriminant fields (`type` and its variant-specific
  companions). Extra client-sent fields on `body.thinking` do not count
  as equal, so the step always normalizes to the policy shape.
- GLM requests now carry `clear_thinking: false` and Kimi/Coder
  requests now carry `keep: "all"` on the Anthropic route when stamping
  is on and thinking is enabled. Harnesses that rely on the old
  `{ type: "adaptive" }` shape for these models will see the new shape
  in both the forwarded request and the captured body.
- ADR-0011's forcing rule ("force to `{ type: "adaptive" }`") is
  superseded for GLM, Kimi, and Coder families. The rule still holds for
  `umans-flash`, `umans-qwen*`, and the fallback `*` policy, whose
  `thinkingShape` remains `{ type: "adaptive" }`.
