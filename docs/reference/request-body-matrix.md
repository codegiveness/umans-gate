# Request Body Stamp Matrix

Complete reference for how `umans-gate` modifies request bodies and headers
on both Anthropic and OpenAI routes. Covers all stamp pipeline steps,
per-model rules, and experimental body modifications.

## Config flags (3 master switches)

| Config key | Default | Controls |
|---|---|---|
| `stamp_claude_code_enabled` | `false` | Anthropic route: TTL, breakpoints, max_tokens, output_config, top_k, temperature, context_management, base `thinking` shape (from `STAMP_OVERLAY`, overridable by `stamp_model_rules`) |
| `stamp_reasoning_effort_enabled` | `false` | OpenAI route: `reasoning_effort` injection (value `"high"` when on) |
| `stamp_model_rules` | `[]` (empty) | Per-model overrides on BOTH routes. Independent of the 2 switches above. |

When `stamp_model_rules` is empty → no per-model overrides, only the static
`STAMP_OVERLAY` applies.

> **PerModelRule fires regardless of master switches.** A rule with
> `pattern: "umans-glm-*"` and `anthropic_thinking_shape` will override
> `body.thinking` on the Anthropic route even when
> `stamp_claude_code_enabled: false`. The other 9 steps still require
> their master switch.

All three are hot-reloadable (no restart needed).

## Hardcoded stamp constants

| Constant | Value | Used by |
|---|---|---|
| `STAMP_CACHE_TTL_VALUE` | `"1h"` (1 hour) | CacheTtlStep — stamps `ttl` on `cache_control: {type:"ephemeral"}` blocks |
| `STAMP_TOP_K_VALUE` | `20` | TopKStep — injected as `top_k` |
| `STAMP_TEMPERATURE_VALUE` | `1.0` | TemperatureStep — forced when thinking enabled |
| `STAMP_REASONING_EFFORT_VALUE` | `"high"` | OpenAiReasoningStep — default effort when `stamp_reasoning_effort_enabled` is on |
| `STAMP_ANTHROPIC_BETA_HEADER` | (long string, see `src/config/constants.ts`) | **Header** (not body). Injected as `anthropic-beta` header on `/v1/messages` requests when `stamp_claude_code_enabled: true`. |
| `STAMP_CONTEXT_MANAGEMENT_VALUE` | `{edits:[{type:"clear_thinking_20251015",keep:"all"}]}` | ContextManagementStep — injected as `context_management` (deep-copied) |

## Pipeline order (10 steps)

```
 1. RestampBreakpoints    — Anthropic only, gated on stampClaudeCode
 2. CacheTtl              — Anthropic only, gated on stampClaudeCode
 3. AnthropicBody         — Anthropic only, gated on stampClaudeCode
 4. PerModelRule          — BOTH routes, gated on stampModelRules.length > 0 + rule match
 5. ContextManagement     — Anthropic only, applies(): stampClaudeCode && !isOpenAi; apply(): isThinkingEnabled
 6. OpenAiReasoning       — OpenAI only, gated on stampReasoningEffort !== null
 7. OpenAiStreamUsage     — OpenAI only, gated on stampReasoningEffort (applies); stream=true + include_usage not set (apply)
 8. TopK                  — Both routes, gated on route master switch (stampClaudeCode / stampReasoningEffort) + policy.top_k !== null
 9. Temperature           — Anthropic only, applies(): stampClaudeCode && !isOpenAi; apply(): isThinkingEnabled
10. StripOmoReminder      — Anthropic only, gated on experimentStripOmoReminder
```

> **Gating note:** Gating shown is primarily `applies()` (pipeline gate).
> Several steps have additional runtime guards in `apply()` — noted in the
> "What each step stamps" tables below.

## STAMP_OVERLAY (static, code-level)

All entries have `thinkingShape: {type:"adaptive"}`. The `*` fallback has
`thinking: true` (thinking is supported for all models by default).
Patterns matched in declaration order; first match wins. `"*"` is the
fallback for any unmatched model.

| Pattern | max_tokens | effort | thinking | top_k | canDisable | thinkingShape |
|---|---|---|---|---|---|---|
| `umans-glm*` | 131071 | max | true | 20 | true | `{type:"adaptive"}` |
| `umans-coder` | 32767 | high | true | null | false | `{type:"adaptive"}` |
| `umans-flash` | 32767 | high | true | null | true | `{type:"adaptive"}` |
| `umans-kimi-k3` | 131071 | max | true | null | true | `{type:"adaptive"}` |
| `umans-kimi*` | 32767 | high | true | null | false | `{type:"adaptive"}` |
| `umans-qwen*` | 32767 | high | true | null | true | `{type:"adaptive"}` |
| `*` (fallback) | 32767 | high | true | null | true | `{type:"adaptive"}` |

`canDisableThinking` is overridden at runtime from `/v1/models/info`
`reasoning.can_disable` by `model-info-parser.ts`, which spreads the overlay
entry then sets `canDisableThinking: reasoning.can_disable === true`.
`resolveStampPolicy()` returns the catalog entry (with override) when
present. When the catalog is unavailable (no `UMANS_API_KEY` or fetch
failed), `resolveStampPolicy()` falls back to `matchStampOverlay()` and the
overlay's `canDisableThinking` is used as-is.

## PerModelRule fields

| Field | Route | Type | Effect |
|---|---|---|---|
| `pattern` | both | string (glob) | Model name match. First-match-wins. `*` suffix = prefix match. |
| `anthropic_thinking_shape` | Anthropic | ThinkingConfig | Forces `body.thinking` to this shape. Overrides overlay. |
| `openai_thinking_shape` | OpenAI | ThinkingConfig | Forces `body.thinking` to this shape. If client thinking null/disabled → `{type:"disabled"}`. |
| `openai_extra_body` | BOTH | object | Shallow-merges into `body.extra_body`. Applies on both routes. |
| `openai_veto_reasoning_effort` | OpenAI | boolean | Surgically skips `reasoning_effort` injection. Still strips output_config/context_management + forces temp=1.0 — but only when thinking is enabled. When thinking is absent or disabled, veto = no-op. |

## ThinkingConfig union (4 variants)

```typescript
{ type: "adaptive" }                          // proxy decides dynamically
{ type: "enabled"; keep: "all" }              // Kimi Preserved Thinking
{ type: "enabled"; clear_thinking: boolean }   // Z.ai Preserved Thinking (false = preserve ON)
{ type: "enabled" }                            // Qwen bare enabled
```

---

## Anthropic route — `stamp_claude_code_enabled: true`

Steps 1-3 + 5 + 8 + 9 fire. Step 4 (PerModelRule) fires if rules exist.
Step 10 (StripOmoReminder) fires additionally if
`experiment_strip_omo_reminder: true`.

### What each step stamps

| Step | What it does |
|---|---|
| 1. RestampBreakpoints | Rewrites `cache_control` breakpoints to Layout B (system[0] + last user message). Runs first so CacheTtl stamps the restamped breakpoints. See ADR-0002. |
| 2. CacheTtl | Stamps `ttl="1h"` on all `cache_control: {type:"ephemeral"}` blocks that lack a `ttl`. |
| 3. AnthropicBody | Forces `body.thinking` to overlay's `{type:"adaptive"}` (only if thinking present; never injected when absent). Sets `max_tokens` (only if thinking enabled). Injects `output_config={effort: policy.effort}` (only if thinking enabled AND `policy.thinking`). Strips `reasoning_effort` if present. |
| 4. PerModelRule | **Overrides** `body.thinking` with rule's `anthropic_thinking_shape` (wins over step 3). Also merges `extra_body` if rule has it. |
| 5. ContextManagement | Injects `context_management={edits:[{type:"clear_thinking_20251015",keep:"all"}]}` (deep-copied). Guard: `isThinkingEnabled(body.thinking)` must be true. |
| 8. TopK | Injects `top_k=20` (only GLM has `top_k=20`; others null → skip). Guard: `isThinkingEnabled` must be true. |
| 9. Temperature | Forces `temperature=1.0`. Guard: `isThinkingEnabled` must be true. |
| 10. StripOmoReminder | Removes text blocks starting with `\n[Category+Skill Reminder]` from `messages[0].content` only; preserves all other blocks and cache_control breakpoints. |

### Thinking forcing semantics (AnthropicBodyStep)

- `body.thinking` absent → never injected (left absent).
- `body.thinking` disabled form (`type:"disabled"`, `type:"off"`, `type:"none"`, `enabled:false`) AND `canDisableThinking: true` → respected.
- `body.thinking` disabled form AND `canDisableThinking: false` → forced to `policy.thinkingShape` (e.g. Kimi K2.7 where reasoning cannot be disabled).
- Any other thinking shape → forced to `policy.thinkingShape`.

### Per-model final body (Anthropic, all stamps on + all 6 rules configured)

| Model | Step 3 thinking | Step 4 rule shape | FINAL thinking | max_tokens | output_config | top_k | temperature | context_mgmt | extra_body |
|---|---|---|---|---|---|---|---|---|---|
| umans-kimi-k2.7 | {adaptive} | {enabled,keep:all} | **{enabled,keep:all}** | 32767 | {effort:high} | — | 1.0 | ✅ | — |
| umans-glm-5.2 | {adaptive} | {enabled,clear_thinking:false} | **{enabled,clear_thinking:false}** | 131071 | {effort:max} | 20 | 1.0 | ✅ | — |
| umans-coder | {adaptive} | {enabled,keep:all} | **{enabled,keep:all}** | 32767 | {effort:high} | — | 1.0 | ✅ | — |
| umans-kimi-k3 | {adaptive} | {adaptive} | **{type:adaptive}** | 131071 | {effort:max} | — | 1.0 | ✅ | — |
| umans-flash | {adaptive} | {enabled} (bare) | **{type:enabled}** | 32767 | {effort:high} | — | 1.0 | ✅ | — |
| umans-qwen3.6-35b-a3b | {adaptive} | {enabled} (bare) | **{type:enabled}** | 32767 | {effort:high} | — | 1.0 | ✅ | — |
| unknown model | {adaptive} | (no rule) | **{type:adaptive}** | 32767 | {effort:high} | — | 1.0 | ✅ | — |

> `extra_body` is also merged on the Anthropic route if the rule has
> `openai_extra_body` set (applies to both routes per code).

> `output_config` effort comes from `policy.effort`: `umans-glm*` + `umans-kimi-k3` = `"max"`, all others = `"high"`.

### Header & URL side-effects (Anthropic, stampClaudeCode on)

These are header/URL modifications, not body stamps, but are part of the
same Claude Code stamp bundle:

- Appends `?beta=true` to the upstream URL on `/v1/messages` requests.
- Injects `anthropic-beta: <STAMP_ANTHROPIC_BETA_HEADER>` header.
- Injects `anthropic-version: 2023-06-01` header (replaces any client value).

---

## OpenAI route — `stamp_reasoning_effort_enabled: true`

Steps 4 + 6 + 7 fire. Step 8 (TopK) fires only if `policy.top_k !== null`
AND `body.reasoning_effort` is present.

### What each step stamps

| Step | What it does |
|---|---|
| 4. PerModelRule | Sets `body.thinking` to rule's `openai_thinking_shape`. If client thinking is null/disabled → `{type:"disabled"}`. Merges `extra_body` if rule has it. |
| 6. OpenAiReasoning | Calls `stampReasoning()`: injects `reasoning_effort` from `policy.effort` (unless vetoed). Strips `output_config` + `context_management`. Forces `temperature=1.0`. **Thinking is NEVER stripped** — PerModelRuleStep owns it. |
| 7. OpenAiStreamUsage | Injects `stream_options={include_usage:true}` if `stream=true`. Skips if `stream_options.include_usage` is already `true`. |
| 8. TopK | Injects `top_k=20` (only GLM + only if reasoning_effort present). |

### stampReasoning behavior matrix

| Client state | veto=false | veto=true |
|---|---|---|
| thinking absent + reasoning absent | no-op | no-op |
| thinking absent + reasoning present | force reasoning_effort to policy.effort; strip output_config/context_management; force temp=1.0 | no-op |
| thinking enabled + reasoning absent | inject reasoning_effort from policy.effort; strip; force temp=1.0 | skip injection; strip output_config/context_management; force temp=1.0 |
| thinking disabled + reasoning absent | no-op | no-op |
| thinking disabled + reasoning present + canDisable | respect (no-op) | no-op |
| thinking disabled + reasoning present + !canDisable | force reasoning_effort; strip; force temp=1.0 | no-op |

> Under veto, the code only looks at thinking state, not reasoning state.
> If thinking is enabled → strip + force temp (no injection). If thinking
> is absent or disabled → no-op, regardless of reasoning_effort presence.

### Per-model final body (OpenAI, all stamps on + all 6 rules configured)

| Model | Step 4 thinking | Step 4 extra_body | Step 6 reasoning_effort | Step 6 temp | Step 8 top_k | Veto? |
|---|---|---|---|---|---|---|
| umans-kimi-k2.7 | {enabled,keep:all} | — | NOT injected | 1.0 | — | YES |
| umans-glm-5.2 | {enabled,keep:all} | — | **max** | 1.0 | 20 | no |
| umans-coder | {enabled,keep:all} | — | NOT injected | 1.0 | — | YES |
| umans-kimi-k3 | {enabled} | — | **max** | 1.0 | — | no |
| umans-flash | {enabled} | {enable_thinking:true, preserve_thinking:true} | **high** | 1.0 | — | no |
| umans-qwen3.6-35b-a3b | {enabled} | {enable_thinking:true, preserve_thinking:true} | **high** | 1.0 | — | no |
| unknown model | {enabled} | — | **high** | 1.0 | — | no |

Key points:

- `reasoning_effort` value comes from `policy.effort`: GLM + kimi-k3 = `"max"`, all others = `"high"`.
- Veto models (kimi-k2.7, coder): `reasoning_effort` never injected (vendor errors on it). Output_config/context_management still stripped, temperature still forced to 1.0 — guaranteed in practice because veto models force `thinking: {enabled}` via per-model rule and `canDisableThinking: false` in the overlay.
- Thinking is **preserved** (set by PerModelRuleStep, never deleted by stampReasoning).
- `extra_body` merges on **both** routes (not just OpenAI).

---

## Experimental body modifications

These flags are off by default and modify the body outside the 10-step
stamp pipeline.

### `experiment_rewrite_ids` (default: false)

On a 502 or 529 upstream response containing `overloaded_error`, rewrites
ID fields in the request body and retries:

- Rewrites every `call_*` / `toolu_*` tool_use ID via deterministic SHA-256
  (salt + saltVersion + originalId → 24-char hex, prefix preserved).
- Rewrites `x-session-id` / `x-session-affinity` headers (mapped to `ses_*`).
- Eligibility: harness = opencode (User-Agent) AND `x-session-id` header
  matches `^ses_[A-Za-z0-9]{16,}$`.
- Salt escalates every 2 consecutive 502s (new salt + incremented version).
- Mappings persisted in `id_rewrite_sessions` / `id_rewrite_mappings` SQLite
  tables; TTL = `experiment_rewrite_ttl_ms` (default 1h).

This is a retry-path body modification, not a pre-forward stamp. It fires
after the stamp pipeline has already run on the original attempt.

### `experiment_strip_omo_reminder` (default: false)

See step 10 (StripOmoReminder) above. Anthropic route only. Removes
`\n[Category+Skill Reminder]` text blocks from `messages[0].content` only;
preserves all other blocks and cache_control breakpoints.

### `experiment_ttft_watchdog` (default: false)

Does NOT modify the request body. Aborts upstream fetches that stall
before first byte within `ttft_timeout_ms`, then retries. The retry may
trigger `experiment_rewrite_ids` body rewriting if the retry hits a 502/529.

---

## Full config.json example (all models enabled)

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

---

## Reference docs

- z.ai (thinking mode): https://docs.z.ai/guides/capabilities/thinking-mode
- z.ai (reasoning_effort): https://docs.z.ai/guides/capabilities/thinking
- z.ai (migration): https://docs.z.ai/guides/overview/migrate-to-glm-new
- kimi (thinking models): https://platform.kimi.ai/docs/guide/use-thinking-models
- kimi (reasoning_effort): https://platform.kimi.ai/docs/guide/use-reasoning-effort
- qwen (thinking): https://docs.qwencloud.com/developer-guides/text-generation/thinking
- umans /v1/models/info: https://api.code.umans.ai/v1/models/info
- ADR-0029: Per-model stamp rules table
- ADR-0011: Thinking stamping rules
- ADR-0017: Per-family thinkingShape
