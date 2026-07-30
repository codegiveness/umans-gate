# ADR-0029: Per-model stamp rules table

Status: Accepted (2026-07-29). Revised (2026-07-29).

Supersedes: ADR-0019 (version-gated child toggles)

## Context

ADR-0019 introduced two vendor-specific config flags —
`stamp_glm_5_2_thinking_enabled` and `stamp_kimi_k2_7_code_thinking_enabled` —
to control thinking shape on Anthropic routes. Each flag was gated on
`stamp_claude_code_enabled` (parent toggle) and matched model names via
substring version checks (`"5.2"`, `"k2.7-code"`).

This approach had three problems:

1. **Vendor-coupled**: adding a new model family required a new config flag +
   new code in `applyModelSpecificThinkingOverride`. The set of supported
   vendors was hardcoded.

2. **Anthropic-only**: the child toggles only affected the Anthropic route.
   OpenAI routes had no per-model thinking behavior — all models got uniform
   `reasoning_effort` injection with no way to veto or add `extra_body`.

3. **Substring matching fragility**: `modelVersionMatches` used `.includes()`,
   matching `"5.2"` in `umans-glm-15.2` etc. Model names from `/v1/models/info`
   were authoritative but not used.

## Decision

Replace the vendor-specific flags with a **per-model rules table** in
`config.json` (`stamp_model_rules`). Each rule matches a model name pattern
(glob, first-match-wins) and can:

- `anthropicThinkingShape`: force the thinking shape on Anthropic routes.
- `openaiThinkingShape`: force the thinking shape on OpenAI routes.
- `openaiExtraBody`: merge into `body.extra_body` on BOTH routes.
- `openaiVetoReasoningEffort`: skip `reasoning_effort` injection on OpenAI
  routes (for models that error on it).

### STAMP_OVERLAY unified to adaptive

All `STAMP_OVERLAY` entries now use `thinkingShape: { type: "adaptive" }`.
The `*` fallback entry now has `thinking: true` (was `false`). Per-model rules
override the overlay's adaptive shape with vendor-specific shapes when needed.

A new `umans-kimi-k3` overlay entry was added with `max_tokens: 131071`,
`effort: "max"` (from `/v1/models/info`).

### `stampReasoning` no longer strips thinking

`stampReasoning` previously stripped the `thinking` field as part of
`reasoning_effort` injection. This is now removed — `PerModelRuleStep`
controls the `thinking` field via `openaiThinkingShape`. `stampReasoning`
still strips `output_config`/`context_management` and forces `temperature=1.0`.

### Independence

Per-model rules are **independent** of `stamp_claude_code_enabled` and
`stamp_reasoning_effort_enabled`:

- A rule fires whenever a matching model is detected, regardless of whether
  the master toggles are on.
- Rules complement (do not replace) the master toggles: `stampClaudeCode`
  still gates TTL, top_k, max_tokens, output_config, context_management,
  temperature. `stampReasoningEffort` still gates `reasoning_effort`
  injection. Rules only control thinking shape and extra_body.

### Pipeline position

A new `PerModelRuleStep` at pipeline position 4 (after `AnthropicBodyStep`,
before `ContextManagementStep` and `OpenAiReasoningStep`):

```
1. RestampBreakpoints
2. CacheTtl
3. AnthropicBody
4. PerModelRule (NEW)
5. ContextManagement
6. OpenAiReasoning
7. OpenAiStreamUsage
8. TopK
9. Temperature
10. StripOmoReminder
```

This position ensures:
- Rules can override `AnthropicBodyStep`'s thinkingShape (rule wins).
- A rule-forced thinking enables `ContextManagementStep` (isThinkingEnabled).
- Veto flag is visible before `OpenAiReasoningStep` reads it.

### ThinkingConfig union extension

Added `{ type: "enabled" }` (bare) variant for Qwen models that use
`enable_thinking` + `preserve_thinking` via `extra_body` rather than a
thinking object with `keep` or `clear_thinking`.

`thinkingEquals()` updated to handle bare enabled: equal only to another
bare enabled, not to enabled-with-keep or enabled-with-clear_thinking.

### `canDisableThinking` invariant preserved

`canDisableThinking` continues to come from `/v1/models/info`
`reasoning.can_disable` (overridden at parse time). Per-model rules do NOT
override it — it stays from the resolved overlay policy.

## Consequences

- **Positive**: Adding a new model family is a config.json edit, not a code
  change. Per-model behavior works on both Anthropic and OpenAI routes.
- **Positive**: Model names use exact/glob matching (not substring), reducing
  false matches.
- **Positive**: Orphan config keys (`stamp_glm_5_2_thinking_enabled` in
  existing configs) are silently ignored — no migration needed.
- **Positive**: `stampReasoning` no longer strips thinking — clean separation
  of concerns (PerModelRuleStep owns thinking, stampReasoning owns
  reasoning_effort + temperature + output_config strip).
- **Negative**: Users must populate `stamp_model_rules` to get vendor-specific
  thinking shapes. Default is empty (all models get adaptive from overlay).
- **Negative**: The dashboard uses a JSON textarea for the rules array (not a
  structured table editor). Power-user friendly but not beginner-friendly.

## Target spec (all models)

| umans model | Anthropic thinkingShape | OpenAI thinkingShape | OpenAI extra_body | reasoning_effort veto |
|---|---|---|---|---|
| umans-kimi-k2.7 | `{type:enabled, keep:all}` | `{type:enabled, keep:all}` | — | YES |
| umans-glm-5.2 | `{type:enabled, clear_thinking:false}` | `{type:enabled, keep:all}` | — | no |
| umans-coder | `{type:enabled, keep:all}` | `{type:enabled, keep:all}` | — | YES |
| umans-kimi-k3 | `{type:adaptive}` | `{type:enabled}` | — | no |
| umans-flash | `{type:enabled}` | `{type:enabled}` | `{enable_thinking:true, preserve_thinking:true}` | no |
| umans-qwen3.6-35b-a3b | `{type:enabled}` | `{type:enabled}` | `{enable_thinking:true, preserve_thinking:true}` | no |

## Full config.json example (all 6 models)

```json
{
  "stamp_claude_code_enabled": true,
  "stamp_reasoning_effort_enabled": true,
  "stamp_model_rules": [
    {
      "pattern": "umans-kimi-k2.7",
      "anthropic_thinking_shape": { "type": "enabled", "keep": "all" },
      "openai_thinking_shape": { "type": "enabled", "keep": "all" },
      "openai_veto_reasoning_effort": true
    },
    {
      "pattern": "umans-glm-*",
      "anthropic_thinking_shape": { "type": "enabled", "clear_thinking": false },
      "openai_thinking_shape": { "type": "enabled", "keep": "all" }
    },
    {
      "pattern": "umans-coder",
      "anthropic_thinking_shape": { "type": "enabled", "keep": "all" },
      "openai_thinking_shape": { "type": "enabled", "keep": "all" },
      "openai_veto_reasoning_effort": true
    },
    {
      "pattern": "umans-kimi-k3",
      "anthropic_thinking_shape": { "type": "adaptive" },
      "openai_thinking_shape": { "type": "enabled" }
    },
    {
      "pattern": "umans-flash",
      "anthropic_thinking_shape": { "type": "enabled" },
      "openai_thinking_shape": { "type": "enabled" },
      "openai_extra_body": { "enable_thinking": true, "preserve_thinking": true }
    },
    {
      "pattern": "umans-qwen*",
      "anthropic_thinking_shape": { "type": "enabled" },
      "openai_thinking_shape": { "type": "enabled" },
      "openai_extra_body": { "enable_thinking": true, "preserve_thinking": true }
    }
  ]
}
```

## Reference docs

- z.ai: https://docs.z.ai/guides/capabilities/thinking-mode
- z.ai (reasoning_effort): https://docs.z.ai/guides/capabilities/thinking
- z.ai (migration): https://docs.z.ai/guides/overview/migrate-to-glm-new
- kimi: https://platform.kimi.ai/docs/guide/use-thinking-models
- kimi (reasoning_effort): https://platform.kimi.ai/docs/guide/use-reasoning-effort
- qwen: https://docs.qwencloud.com/developer-guides/text-generation/thinking
- umans /v1/models/info: https://api.code.umans.ai/v1/models/info
