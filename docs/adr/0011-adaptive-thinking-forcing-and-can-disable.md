# Adaptive thinking forcing, can_disable, reasoning_effort forcing, and thinking stripping

Status: Accepted (supersedes parts of ADR-0008)
Date: 2026-07-24

## Context

umans-gate's "respect-if-present" stamping policy from ADR-0008 produced
three request-shape inconsistencies in practice.

First, non-adaptive `thinking` blocks passed through unchanged: a client
sending `thinking: { type: "enabled", budget_tokens: 1024 }` reached the
upstream with that fixed budget instead of the proxy's intended
`{ type: "adaptive" }`. The `STAMP_THINKING_VALUE` constant existed in
`config/constants.ts` but was not consumed by any code path.

Second, Kimi K2.7 models report `reasoning.can_disable: false` in
`/v1/models/info` for `umans-kimi*` and `umans-coder`. A client sending
`thinking: { type: "disabled" }` was respected, but the model ignored the flag
and reasoned anyway. The proxy forwarded a disabled thinking block that had
no effect, while skipping `output_config` and `temperature` stamping because
those steps were gated on thinking being enabled.

Third, OpenAI-style `reasoning_effort` leaked into Anthropic
`/v1/messages` requests. That field is not a valid Anthropic body
parameter and was left untouched under ADR-0008.

## Decision

### Rule: force-to-adaptive when present and non-disabled

When `stampClaudeCode` is enabled and the body has a `thinking` field, the
proxy transforms it according to this table:

| `thinking` shape | `canDisableThinking: true` | `canDisableThinking: false` |
|---|---|---|
| Absent | Not injected | Not injected |
| Disabled (`type: "disabled"`, `"off"`, `"none"`, or `enabled: false`) | **Respected** | **Forced to `{ type: "adaptive" }`** |
| Any other shape (`{ type: "enabled", budget_tokens: ... }`, etc.) | **Forced to `{ type: "adaptive" }`** | **Forced to `{ type: "adaptive" }`** |

Disabled forms are recognized case-insensitively by `type` value, or by an
`enabled: false` flag. Any other shape, including `{ type: "enabled" }` with
extra fields like `budget_tokens`, is forced to `{ type: "adaptive" }`.

If the thinking block is already `{ type: "adaptive" }`, the proxy does not
rewrite it. No write means no spurious `changed = true`.

### Rule: all body stamps gated on thinking enabled

When `stampClaudeCode` is enabled on Anthropic routes, **all body stamps are
gated on thinking being enabled** (present and not disabled). Only TTL/cache
control stamping is independent of thinking.

When thinking is **absent or disabled** (and respected):

| Field | Stamped? |
|---|---|
| `max_tokens` | No (original value preserved) |
| `thinking` | No (not injected) |
| `output_config` | No |
| `temperature` | No |
| `top_k` | No |
| `context_management` | No |
| TTL on `cache_control` ephemeral blocks | **Yes** (always) |

This **supersedes** ADR-0008's rule that "max_tokens always stamps; it
controls output length, independent of thinking." The rationale: when a
client sends no thinking (or disables it), they are opting out of the
full Claude Code stamp bundle. Stamping `max_tokens`, `top_k`, and
`context_management` on a non-thinking request produces an inconsistent
request shape that mixes thinking-dependent fields with a non-thinking body.

When thinking is **enabled** (present and not disabled), all stamps apply
as described in the rules above.

### Rule: can_disable drives the decision

`StampPolicy.canDisableThinking` is populated from
`/v1/models/info` `reasoning.can_disable` at parse time
(`parseModelInfoResponse` overrides the overlay default with the upstream
value). The `STAMP_OVERLAY` provides fallback values when the catalog is
unavailable:

| Model family | `canDisableThinking` | Source |
|---|---|---|
| `umans-glm*` | `true` | `/v1/models/info` + overlay |
| `umans-coder` | `false` | `/v1/models/info` + overlay (Kimi K2.7 base) |
| `umans-flash` | `true` | `/v1/models/info` + overlay |
| `umans-kimi*` | `false` | `/v1/models/info` + overlay |
| `umans-qwen*` | `true` | `/v1/models/info` + overlay |
| `*` (unknown) | `true` | overlay (safe default: respect client) |

This **supersedes** ADR-0008's section "can_disable is informational"; the
field now directly affects stamping.

### Rule: strip reasoning_effort on Anthropic routes

When `stampClaudeCode` is enabled and the request is Anthropic (not OpenAI),
`AnthropicBodyStep` deletes any `reasoning_effort` field from the body. This
field is OpenAI-specific and has no meaning on `/v1/messages`. The OpenAI
route (`OpenAiReasoningStep`) is unaffected and continues to respect
`reasoning_effort` per ADR-0008.

### What stays from ADR-0008

- `thinking` is still **never injected** when absent. The absence is a
  deliberate client choice.
- `max_tokens` always stamps from policy.
- `output_config` is stamped only when thinking is enabled (present and not
  disabled).
- `temperature: 1.0` is forced only when thinking is enabled.
- OpenAI `reasoning_effort` is still respected on OpenAI routes.

### Rule: OpenAI reasoning_effort forcing and thinking stripping

When `stampReasoningEffort` is enabled (non-null) on OpenAI routes,
`stampReasoning()` now enforces real forcing semantics instead of being
a no-op:

| `reasoning_effort` | `thinking` | `canDisableThinking` | Action |
|---|---|---|---|
| Absent | Absent | n/a | Do nothing (respect absence) |
| Absent | Enabled (non-disabled) | n/a | **Inject** `reasoning_effort` = `policy.effort`, **strip** `thinking` |
| Absent | Disabled | n/a | Respect (leave alone) |
| Present, disabled value (`off`/`none`/`null`) | any | `true` | **Respect** (leave alone) |
| Present, disabled value | any | `false` (Kimi, Coder) | **Force** to `policy.effort`, **strip** `thinking` |
| Present, any other value | any | n/a | **Force** to `policy.effort`, **strip** `thinking` |

The target effort is `policy.effort` (`"max"` for `umans-glm*`, `"high"` for
others), NOT the `STAMP_REASONING_EFFORT_VALUE` config constant (which is
always `"high"`). This matches the Anthropic route's `output_config.effort`
behavior: GLM models get `"max"`.

When `reasoning_effort` is present or injected, `thinking` is **stripped** from
the body. This handles the case where a harness configured for Anthropic-style
`thinking` sends to the OpenAI `/v1/chat/completions` endpoint; the
Anthropic-style `thinking` block has no meaning on an OpenAI route when
`reasoning_effort` is the active reasoning control.

Additionally, `output_config` and `context_management` are **stripped** when
reasoning is active. These are Anthropic-specific fields that have no place on
an OpenAI route. `temperature` is **forced to 1.0**; reasoning models reject
`temperature != 1.0`.

Disabled `reasoning_effort` values are: `"off"`, `"none"`, `"null"` (case
insensitive), and `null`/`undefined`. These are the OpenAI equivalents of
`thinking: { type: "disabled" }`.

This **supersedes** ADR-0008's OpenAI path entirely. ADR-0008 made
`OpenAiReasoningStep` a structural no-op that never injected, stripped, or
overwrote anything. The step now calls `stampReasoning()` with the resolved
policy and enforces the rules above.

## Alternatives considered

- **Pure force-stamp (pre-ADR-0008)**: always overwrite to adaptive,
  including injecting when absent. Rejected (again) because injecting thinking
  when the client omitted it changes request semantics for clients that
  intentionally disable thinking for cost/latency.

- **Respect all non-adaptive shapes (ADR-0008 as-is)**: leave
  `{ type: "enabled", budget_tokens: 1024 }` untouched. Rejected because the
  proxy's stamp bundle is designed to produce a consistent Anthropic request
  shape, and `budget_tokens` with a fixed budget defeats the adaptive thinking
  the upstream expects.

- **Strip disabled thinking entirely** instead of forcing to adaptive.
  Rejected because an absent thinking block causes `output_config` and
  `temperature` stamping to be skipped, producing an inconsistent request.

## Consequences

- `StampPolicy` gains a `canDisableThinking: boolean` field. All overlay
  entries and `parseModelInfoResponse` must populate it.
- `StampOptions` gains a `thinking?: boolean` option. The pipeline passes
  `thinking: true` in `AnthropicBodyStep`.
- `StampReasoningOptions` gains a `policy?: StampPolicy` option. The pipeline
  passes the resolved policy in `OpenAiReasoningStep`.
- `isThinkingDisabled()` and `isThinkingEnabled()` are exported from
  `stamp-thinking.ts` for reuse by `TemperatureStep` and `stampReasoning`.
- `STAMP_THINKING_VALUE` is now consumed by `stampThinking()`.
- `stampReasoning()` is no longer a no-op. It injects, forces, and strips
  per the truth table above. It also strips `output_config` and
  `context_management`, and forces `temperature: 1.0` when reasoning is active.
- `OpenAiBody` type gains `temperature`, `output_config`, and
  `context_management` fields to support the stripping logic.
- `stampThinking()` `maxTokens` option is now gated on `isThinkingEnabled`;
  `max_tokens` is not stamped when thinking is absent or disabled.
- `ContextManagementStep` skips when thinking is absent or disabled.
- `TopKStep` skips when thinking is absent or disabled.
- `OpenAiBody.reasoning_effort` type widened from `"high" | "max"` to
  `string` to accept disabled values (`"off"`, `"none"`, `"low"`, etc.).
- `AnthropicBodyStep` deletes `reasoning_effort` from the body.
- `OpenAiReasoningStep` calls `stampReasoning()` with the resolved policy
  instead of being a structural no-op.
- ADR-0008's "can_disable is informational" section is superseded.
- ADR-0008's OpenAI path truth table is superseded; `reasoning_effort` is
  now injected from `thinking`, forced to `policy.effort`, and `thinking` is
  stripped when `reasoning_effort` is active.
- ADR-0008's truth table for `thinking` is updated: "Respect (no overwrite)"
  becomes "Force to adaptive" for non-disabled shapes, and for disabled shapes
  when `canDisableThinking: false`.
