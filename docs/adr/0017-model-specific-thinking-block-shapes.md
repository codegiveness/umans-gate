# Model-specific thinking block shapes

Status: Accepted
Date: 2026-07-25

## Context

umans-gate's Anthropic/Claude-Code stamp path forces every non-disabled
`thinking` block to `{ type: "adaptive" }` (ADR-0011), regardless of
model family. That shape works for adaptive-thinking models
(`umans-flash`, `umans-qwen*`, and the fallback `*` policy), but it drops
two model-specific signals.

GLM Preserved Thinking requires `thinking: { type: "enabled",
clear_thinking: false }` on the standard API endpoint (Z.ai docs:
https://docs.z.ai/guides/capabilities/thinking-mode). The default
endpoint clears `reasoning_content` across turns (`clear_thinking: true`);
forcing `{ type: "adaptive" }` on `umans-glm*` silently disabled
Preserved Thinking.

Kimi Preserved Thinking requires `thinking: { type: "enabled", keep: "all" }`
(Moonshot docs: https://platform.kimi.ai/docs/guide/use-thinking-models).
`umans-kimi*` and `umans-coder` both derive from Kimi K2.7-Code. Forcing
`{ type: "adaptive" }` on these models dropped the `keep: "all"` signal,
so the proxy ran them without Preserved Thinking on the standard
endpoint.

## Decision

The proxy widens `ThinkingConfig` from a single `{ type: "adaptive" }`
interface to a discriminated union supporting three shapes:

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
`STAMP_THINKING_VALUE` constant) when the forcing path fires, i.e.
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
(ADR-0011). Only the forced *target* shape changes; the gating logic
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
- The `thinkingEquals()` helper is private to `stamp-thinking.ts`; it
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
