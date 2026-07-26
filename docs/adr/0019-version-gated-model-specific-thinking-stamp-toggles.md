# Version-gated model-specific thinking stamp toggles

Status: Accepted
Date: 2026-07-26

## Context

ADR-0017 introduced per-family `thinkingShape` entries in `STAMP_OVERLAY`,
so `umans-glm*` requests got `{ type: "enabled", clear_thinking: false,
budget_tokens: 32000 }` (GLM Preserved Thinking) and `umans-coder` got
`{ type: "enabled", keep: "all", budget_tokens: 32000 }` (Kimi Preserved
Thinking) — unconditionally, whenever `stamp_claude_code_enabled` was on.

That creates two problems:

1. **Behavior lock-in.** The shape is hard-coded per family. Users who
   want Claude Code Style stamping (TTL, max_tokens, output_config,
   context_management) but *not* Preserved Thinking have no way to
   disable just the thinking shape — they must disable the entire parent
   toggle, losing the other stamps.

2. **Version drift.** Preserved Thinking is a GLM-5.2 feature. Z.ai
   documents `reasoning_effort` as GLM-5.2-exclusive and notes that
   GLM-5.2 "auto-decides whether to think." Applying
   `clear_thinking: false` to older GLM variants (5.1, 4.x) is
   wrong-by-default — those models don't support the field.

### Z.ai official references

**Thinking Mode** (https://docs.z.ai/guides/capabilities/thinking-mode):

> We introduce a new capability in coding scenarios: the model can
> retain reasoning content from previous assistant turns in the
> context… This capability is enabled by default on the Coding Plan
> endpoint and disabled by default on the standard API endpoint. If
> you want to enable Preserved Thinking in your product (primarily
> recommended for coding/agent scenarios), you can turn it on for the
> API endpoint by setting `clear_thinking: false`, and you must return
> the complete, unmodified `reasoning_content` back to the API.

**Core Parameters** (https://docs.z.ai/guides/overview/concept-param):

> `reasoning_effort` — only supported by `GLM-5.2` and above.

**Migrate to GLM-5.2** (https://docs.z.ai/guides/overview/migrate-to-glm-new):

> GLM-5.2 auto-decides whether to think (unlike GLM-4.7 which uses
> forced thinking). `reasoning_effort` is new to GLM-5.2.

The clear implication: Preserved Thinking (`clear_thinking: false`) is
an opt-in API feature targeted at coding/agent workloads, primarily
relevant to GLM-5.2 and above. Stamp it unconditionally across all GLM
variants — and worse, across unrelated model families (Kimi, Coder) —
is a behavior change with no user opt-out.

## Decision

Introduce a **child toggle** pattern: per-version Preserved Thinking
shapes are gated behind dedicated config fields, each a child of
`stamp_claude_code_enabled`.

### 1. `stamp_glm_5_2_thinking_enabled`

- Default: `false` (opt-in — existing users must explicitly enable).
- Type: boolean. Hot-reloadable. Lives in `RawConfig`, `ProxyConfig`
  (`stampGlm52Thinking`), `StampConfig`.
- Behavior matrix:

  | Parent (`stamp_claude_code_enabled`) | Child (`stamp_glm_5_2_thinking_enabled`) | Model name matches "5.2" | `thinkingShape` applied |
  |---|---|---|---|
  | OFF | (any) | (any) | No stamping at all |
  | ON | OFF | (any) | `{ type: "adaptive" }` |
  | ON | ON | YES | `{ type: "enabled", clear_thinking: false, budget_tokens: 32000 }` |
  | ON | ON | NO | `{ type: "adaptive" }` (silent fallback) |

### 1b. `stamp_kimi_k2_7_code_thinking_enabled`

- Default: `false` (opt-in — existing users must explicitly enable).
- Type: boolean. Hot-reloadable. Lives in `RawConfig`, `ProxyConfig`
  (`stampKimiK27CodeThinking`), `StampConfig`.
- Behavior matrix:

  | Parent (`stamp_claude_code_enabled`) | Child (`stamp_kimi_k2_7_code_thinking_enabled`) | Model name matches "k2.7-code" | `thinkingShape` applied |
  |---|---|---|---|
  | OFF | (any) | (any) | No stamping at all |
  | ON | OFF | (any) | `{ type: "adaptive" }` |
  | ON | ON | YES | `{ type: "enabled", keep: "all", budget_tokens: 32000 }` |
  | ON | ON | NO | `{ type: "adaptive" }` (silent fallback) |

- `canDisableThinking` is NOT overridden — stays `false` from the Kimi
  overlay. A client-sent `{ type: "disabled" }` on a K2.7-Code request is
  forced to the overridden shape when the child is ON, or to adaptive
  when OFF.

### 2. Version matching via substring

A new helper `modelVersionMatches(modelName, targetVersion)` in
`src/models/version.ts` does substring matching:

```typescript
modelVersionMatches("umans-glm-5.2", "5.2")        // true
modelVersionMatches("umans-glm-5.2-turbo", "5.2")  // true
modelVersionMatches("umans-glm-5.1", "5.2")         // false
```

Substring match (not full semver) is deliberate: model names follow
sundry conventions (`umans-glm-5.2-turbo`,
`umans-kimi-k2.7-code-highspeed`), and the target segment is specific
enough that false positives are not a real risk. `5.22` would match
`5.2`; that is acceptable per spec.

### 3. Override is post-resolution

The override function `applyModelSpecificThinkingOverride(policy,
modelName, config)` runs **after** `resolveStampPolicy` returns the
overlay-derived policy. It checks both GLM 5.2 and Kimi K2.7-Code child
toggles in order (first match wins) and:

- Returns a new `StampPolicy` object (shallow spread) — the base
  `STAMP_OVERLAY` entries are never mutated.
- Replaces only `thinkingShape`.
- Does **NOT** override `canDisableThinking`, `max_tokens`, `effort`,
  `top_k`, `thinking`, or any other overlay field. Those stay from the
  resolved overlay policy.
- Always returns `{ type: "adaptive" }` when the child is OFF or the
  version doesn't match — even for non-GLM models. This is a deliberate
  behavior change documented in CHANGELOG: the previous unconditional
  family-specific shapes are now opt-in.

### 4. `canDisableThinking` is not overridden

`canDisableThinking` controls whether a client-sent
`{ type: "disabled" }` thinking block is respected. The override leaves
it untouched — GLM's `canDisableThinking: true` (from the overlay) stays
true; Kimi/Coder's `false` stays false.

### 5. Parent-child toggle relationship on the dashboard

- Child field has `dependsOn: "stamp_claude_code_enabled"` and
  `experimental: true`.
- Child toggle is disabled in the UI when parent is OFF.
- Turning parent OFF auto-resets child to OFF in the draft (via
  `useConfigDraft.updateField`).
- `experimentalActive` banner shows when child is ON.

## Consequences

- **Default-OFF migration.** Existing users with
  `stamp_claude_code_enabled=true` now get `{ type: "adaptive" }` for
  GLM models instead of the unconditional `clear_thinking: false`
  shape. They must enable `stamp_glm_5_2_thinking_enabled` to restore
  the previous behavior for GLM 5.2 models.

- **Kimi/Coder impact.** Because the override falls back to
  `{ type: "adaptive" }` for any model that doesn't match "5.2",
  `umans-coder` (Kimi family) also gets adaptive instead of the
  previous Kimi Preserved Thinking shape. This is intentional — Ticket
  03 will add a dedicated `stamp_kimi_k2_7_code_thinking_enabled`
  toggle with the same pattern, restoring Kimi Preserved Thinking as
  an explicit opt-in for matching Kimi models.

- **Single seam for future toggles.** The
  `applyModelSpecificThinkingOverride` pattern extends cleanly: each new
  family/version toggle becomes another branch in the override function,
  with the same shape — version match → family shape; otherwise
  adaptive fallback.

## Note

Moonshot references for the Kimi K2.7-Code toggle (Ticket 03) will be
appended here once that toggle lands.

## Moonshot official references (Kimi K2.7-Code)

**Thinking Models guide**
(https://platform.kimi.ai/docs/guide/use-kimi-k2-thinking-model):

> `kimi-k2.7-code`: code-focused; thinking is always on, and Preserved
> Thinking is always on. Only `{"type": "enabled", "keep": "all"}` is
> accepted; any other configuration returns an error.

> Multi-turn `reasoning_content` replay is mandatory: the caller must
> return the complete, unmodified `reasoning_content` from prior assistant
> turns back to the API for Preserved Thinking to function.

**Model Parameter Reference**
(https://platform.kimi.ai/docs/api/models-overview):

> `keep: "all"` is the fixed thinking shape for `kimi-k2.7-code`. The
> model does not accept alternative thinking configurations.

**Version differences** (Moonshot Thinking Models guide):

| Model | Thinking | Preserved Thinking | `reasoning_effort` |
|---|---|---|---|
| `kimi-k2.6` | On by default, can disable | Opt-in via `thinking.keep: "all"` | Not supported |
| `kimi-k2.7-code` | Always on, cannot disable | Always on | Not supported (K3-only) |
| `kimi-k3` | Always reasons | N/A (uses `reasoning_effort`) | Supported |

`reasoning_effort` is a K3-only feature. The proxy must never stamp it
on K2.7-Code — the existing `reasoning_effort` stripping on Anthropic
routes (rule 6) handles this regardless of child toggle state.
