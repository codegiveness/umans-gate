# Respect-if-present stamping for thinking, reasoning_effort, and temperature

## Context

The stamp pipeline's `AnthropicBodyStep` and `OpenAiReasoningStep`
unconditionally overwrote request fields when their respective toggles
were enabled:

- `stampClaudeCode` → forced `thinking`, `max_tokens`, `output_config`,
  `temperature` on every Anthropic request, regardless of what the
  client sent.
- `stampReasoningEffort` → forced `reasoning_effort` and stripped
  `max_tokens`/`thinking` on every OpenAI request, regardless of what
  the client sent.

This violated the principle that the proxy should be transparent when
the client has already made a decision. A client sending
`thinking: { type: "disabled" }` explicitly requested thinking off, but
the proxy overwrote it with `{ type: "adaptive" }`. A client sending no
`reasoning_effort` field intended no reasoning effort, but the proxy
injected `"high"`.

Research into API constraints confirmed that forcing `temperature: 1.0`
when thinking is OFF is unnecessary and potentially harmful:
- Anthropic only rejects `temperature != 1.0` when thinking is
  **enabled**. When thinking is absent or disabled, temperature is
  freely settable (0.0–1.0).
- OpenAI reasoning models reject `temperature` when reasoning is active,
  but accept it when `reasoning_effort` is absent or `"none"`.
- GLM-5.2 has no temperature constraint regardless of thinking state.

Forcing `temperature: 1.0` on requests where thinking is off overrides
the client's chosen sampling temperature for no API reason.

## Decision

Change the stamp semantics from **force-stamp** (overwrite always) to
**respect-if-present** (inject only when the client hasn't already made
the decision).

### Rule: never inject, never overwrite

The proxy **never injects** `thinking` or `reasoning_effort` into a
request that lacks them, and **never overwrites** them when present.
The absence of these fields means the client wants thinking/reasoning
off — the proxy does not intervene.

This is **Position A** — the purest form of "respect the request." It
differs from "inject-if-absent" (which would add thinking when absent)
because the absence is itself a deliberate client choice, not a gap to
fill.

### Anthropic path (`stampClaudeCode` enabled)

| Request `thinking` field | `thinking` stamp | `max_tokens` | `output_config` | `temperature` | TTL, top_k, context_mgmt |
|---|---|---|---|---|---|
| Absent | Skip | Stamp | **Skip** | Leave alone | Stamp |
| `{ type: "disabled" }` | Respect (no overwrite) | Stamp | **Skip** | Leave alone | Stamp |
| `{ type: "adaptive" }` or any enabled | Respect (no overwrite) | Stamp | Stamp | Force 1.0 | Stamp |

- `max_tokens` always stamps — it controls output length, independent of
  thinking.
- `output_config.effort` is coupled to thinking presence — it controls
  reasoning intensity, so injecting it when thinking is off is
  contradictory (throttle on a car that isn't started).
- `temperature: 1.0` is forced only when thinking is present and enabled
  — the Anthropic API rejects `temperature != 1.0` with a 400 error in
  this case.

### OpenAI path (`stampReasoningEffort` enabled, non-null)

| Request `reasoning_effort` field | `reasoning_effort` stamp | Strip `max_tokens`/`thinking`? |
|---|---|---|
| Absent | Skip | No |
| `"none"` / `"off"` | Respect | No |
| Any other value | Respect | No |

The `max_tokens`/`thinking` stripping (previously unconditional) is
eliminated entirely. The stripping existed to prevent conflicts between
`reasoning_effort` and `max_tokens`/`thinking` — but if we're not
injecting `reasoning_effort`, there's no conflict to prevent. When the
request already has `reasoning_effort`, the client sent `max_tokens`
deliberately.

### `can_disable` is informational

The `/v1/models/info` `reasoning.can_disable` field does not affect
stamp decisions. For models where `can_disable: false` (e.g.
`umans-kimi*`, `umans-coder`), not injecting `thinking` does not turn
it off — the model uses its own default. No harm is done by leaving the
field absent.

## Alternatives considered

- **Inject-if-absent, respect-if-present** — inject `{ type: "adaptive" }`
  when `thinking` is absent, respect when present. Rejected because the
  absence of `thinking` is a deliberate client choice to leave thinking
  off, not a gap the proxy should fill. The client (Claude Code,
  opencode, or a custom integration) knows whether it wants thinking.

- **Force-stamp (current behavior)** — always overwrite. Rejected because
  it overrides explicit client decisions, causing unexpected behavior
  when a client intentionally disables thinking for a faster, cheaper
  request.

- **Model-capability-driven** — use `reasoning.can_disable` from the
  catalog to decide whether to inject. Rejected for simplicity: keeping
  the logic uniform (check the request, not the model capability) is
  less surprising and less error-prone. The catalog field remains useful
  for dashboard display.

## Consequences

- `AnthropicBodyStep` splits into conditional branches: `max_tokens`
  always stamps; `thinking` and `output_config` skip when the request
  lacks a `thinking` field; `temperature` is forced only when thinking
  is present and enabled.
- `OpenAiReasoningStep` becomes a no-op when the request lacks
  `reasoning_effort` (no injection, no stripping).
- `TemperatureStep` gains a thinking-presence check before forcing
  `temperature: 1.0`.
- `stampReasoning()` no longer strips `max_tokens`/`thinking` — the
  function signature and tests change.
- The `STAMP_OVERLAY` `thinking: boolean` field and `effort` value
  remain in use for `max_tokens` and `output_config` stamping when
  thinking IS present.
- The `/v1/models/info` `reasoning.can_disable` field is not consumed
  by the stamp pipeline.
