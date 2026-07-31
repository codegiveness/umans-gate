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
> `pattern: "umans-glm-5.2"` and `anthropic_thinking_shape` will override
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
| `openai_thinking_shape` | OpenAI | ThinkingConfig | Forces `body.thinking` to this shape **when a reasoning signal is active** (thinking enabled OR reasoning_effort non-disabled). When no signal is present → no stamp (thinking left untouched). |
| `openai_extra_body` | BOTH | object | Shallow-merges each key at the top level of the request body (not nested under `extra_body`). Applies on both routes. |
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

Steps 1-3 + 4 + 5 + 8 + 9 fire. Step 10 (StripOmoReminder) fires
additionally if `experiment_strip_omo_reminder: true`.

### What each step stamps

| Step | What it does |
|---|---|
| 1. RestampBreakpoints | Rewrites `cache_control` breakpoints to Layout B (system[0] + last user message). Runs first so CacheTtl stamps the restamped breakpoints. See ADR-0002. |
| 2. CacheTtl | Stamps `ttl="1h"` on all `cache_control: {type:"ephemeral"}` blocks that lack a `ttl`. |
| 3. AnthropicBody | Forces `body.thinking` to overlay's `{type:"adaptive"}` (only if thinking present; never injected when absent). Sets `max_tokens` (only if thinking enabled). Injects `output_config={effort: policy.effort}` (only if thinking enabled AND `policy.thinking`). Strips `reasoning_effort` if present. |
| 4. PerModelRule | **Overrides** `body.thinking` with rule's `anthropic_thinking_shape` — but **respects `canDisableThinking`**: when thinking is disabled/absent AND canDisable=true → no force (clean passthrough). When canDisable=false → forces shape AND stamps `max_tokens` + `output_config` (step 3 skipped them). Also merges `openai_extra_body` keys at top level if rule has it. |
| 5. ContextManagement | Injects `context_management={edits:[{type:"clear_thinking_20251015",keep:"all"}]}` (deep-copied). Guard: `isThinkingEnabled(body.thinking)` must be true. |
| 8. TopK | Injects `top_k=20` (only GLM has `top_k=20`; others null → skip). Guard: `isThinkingEnabled` must be true. |
| 9. Temperature | Forces `temperature=1.0`. Guard: `isThinkingEnabled` must be true. |
| 10. StripOmoReminder | Removes text blocks starting with `\n[Category+Skill Reminder]` from `messages[0].content` only; preserves all other blocks and cache_control breakpoints. |

### Thinking forcing semantics (AnthropicBodyStep)

- `body.thinking` absent → never injected (left absent).
- `body.thinking` disabled form (`type:"disabled"`, `type:"off"`, `type:"none"`, `enabled:false`) AND `canDisableThinking: true` → respected.
- `body.thinking` disabled form AND `canDisableThinking: false` → forced to `policy.thinkingShape` (e.g. Kimi K2.7 where reasoning cannot be disabled).
- Any other thinking shape → forced to `policy.thinkingShape`.

### PerModelRule forcing semantics (Anthropic)

Step 4 uses the same `canDisableThinking` policy as step 3:

- `body.thinking` enabled (any non-disabled shape) → **always force** to `anthropicThinkingShape` (overrides step 3's adaptive).
- `body.thinking` disabled/absent AND `canDisableThinking: true` → **respect** (no force, no max_tokens, no output_config). Clean passthrough.
- `body.thinking` disabled/absent AND `canDisableThinking: false` → **force** to `anthropicThinkingShape` AND stamp `max_tokens` + `output_config` (step 3 skipped them because it saw disabled/absent thinking; PerModelRule revives them).

### Per-model Anthropic result matrix (all toggles on + all 6 rules configured)

**Model configurations:**

| # | Pattern | `anthropicThinkingShape` | top-level merge | `effort` | `max_tokens` | `top_k` | `canDisable` |
|---|---|---|---|---|---|---|---|
| 1 | `umans-kimi-k2.7` | `{type:"enabled", keep:"all"}` | — | `"high"` | 32767 | — | `false` |
| 2 | `umans-glm-5.2` | `{type:"enabled", clear_thinking:false}` | — | `"max"` | 131071 | `20` | `true` |
| 3 | `umans-coder` | `{type:"enabled", keep:"all"}` | — | `"high"` | 32767 | — | `false` |
| 4 | `umans-kimi-k3` | `{type:"adaptive"}` | — | `"max"` | 131071 | — | `true` |
| 5 | `umans-flash` | `{type:"enabled"}` (bare) | `{enable_thinking, preserve_thinking}` | `"high"` | 32767 | — | `true` |
| 6 | `umans-qwen3.6-35b-a3b` | `{type:"enabled"}` (bare) | `{enable_thinking, preserve_thinking}` | `"high"` | 32767 | — | `true` |

> `effort`, `max_tokens`, `top_k`, `canDisable` come from `STAMP_OVERLAY` (code-level, intentionally broad globs). `anthropicThinkingShape`, top-level merge come from per-model rules (config-level, model-specific patterns).

#### Scenario T: thinking present (`thinking:{type:"enabled"}` or any non-disabled shape)

Step 3 stamps max_tokens + output_config. Step 4 overrides thinking to rule shape. Steps 5/8/9 fire.

| Model | `thinking` | `max_tokens` | `output_config` | `context_mgmt` | `top_k` | `temp` | top-level merge |
|---|---|---|---|---|---|---|---|
| `umans-kimi-k2.7` | `{type:"enabled", keep:"all"}` | 32767 | `{effort:"high"}` | ✅ | — | `1.0` | — |
| `umans-glm-5.2` | `{type:"enabled", clear_thinking:false}` | 131071 | `{effort:"max"}` | ✅ | `20` | `1.0` | — |
| `umans-coder` | `{type:"enabled", keep:"all"}` | 32767 | `{effort:"high"}` | ✅ | — | `1.0` | — |
| `umans-kimi-k3` | `{type:"adaptive"}` | 131071 | `{effort:"max"}` | ✅ | — | `1.0` | — |
| `umans-flash` | `{type:"enabled"}` | 32767 | `{effort:"high"}` | ✅ | — | `1.0` | `enable_thinking:true, preserve_thinking:true` |
| `umans-qwen3.6-35b-a3b` | `{type:"enabled"}` | 32767 | `{effort:"high"}` | ✅ | — | `1.0` | `enable_thinking:true, preserve_thinking:true` |

#### Scenario D: thinking disabled (`thinking:{type:"disabled"}`)

**canDisable=true** (GLM, kimi-k3, flash, qwen): respect disabled. No force, no max_tokens, no output_config, no context_mgmt, no top_k, no temp.

**canDisable=false** (kimi-k2.7, coder): force shape. Stamp max_tokens + output_config (step 3 skipped them, PerModelRule revives them). context_mgmt + temp fire.

| Model | `thinking` | `max_tokens` | `output_config` | `context_mgmt` | `top_k` | `temp` | `canDisable` |
|---|---|---|---|---|---|---|---|
| `umans-kimi-k2.7` | `{type:"enabled", keep:"all"}` | 32767 | `{effort:"high"}` | ✅ | — | `1.0` | `false` |
| `umans-glm-5.2` | `{type:"disabled"}` (respected) | — | — | — | — | — | `true` |
| `umans-coder` | `{type:"enabled", keep:"all"}` | 32767 | `{effort:"high"}` | ✅ | — | `1.0` | `false` |
| `umans-kimi-k3` | `{type:"disabled"}` (respected) | — | — | — | — | — | `true` |
| `umans-flash` | `{type:"disabled"}` (respected) | — | — | — | — | — | `true` |
| `umans-qwen3.6-35b-a3b` | `{type:"disabled"}` (respected) | — | — | — | — | — | `true` |

#### Scenario N: thinking absent (no `thinking` block)

Same as scenario D — canDisable=true models leave thinking absent, canDisable=false models force + stamp.

| Model | `thinking` | `max_tokens` | `output_config` | `context_mgmt` | `top_k` | `temp` | `canDisable` |
|---|---|---|---|---|---|---|---|
| `umans-kimi-k2.7` | `{type:"enabled", keep:"all"}` | 32767 | `{effort:"high"}` | ✅ | — | `1.0` | `false` |
| `umans-glm-5.2` | absent (respected) | — | — | — | — | — | `true` |
| `umans-coder` | `{type:"enabled", keep:"all"}` | 32767 | `{effort:"high"}` | ✅ | — | `1.0` | `false` |
| `umans-kimi-k3` | absent (respected) | — | — | — | — | — | `true` |
| `umans-flash` | absent (respected) | — | — | — | — | — | `true` |
| `umans-qwen3.6-35b-a3b` | absent (respected) | — | — | — | — | — | `true` |

### Key points (Anthropic route)

- **PerModelRule respects `canDisableThinking`** — same semantics as step 3. canDisable=true → respect disabled/absent. canDisable=false → force shape.
- **canDisable=false models (kimi-k2.7, coder):** always get thinking forced + max_tokens + output_config, even when client sent disabled or absent. PerModelRule stamps max_tokens + output_config directly (step 3 skipped them because it saw disabled/absent thinking).
- **canDisable=true models:** when thinking is disabled/absent → clean passthrough. No thinking, no max_tokens, no output_config, no context_mgmt, no top_k, no temp.
- **context_management, top_k, temperature** only fire when thinking is enabled after all steps — i.e. scenario T (all models) or scenario D/N (canDisable=false models only).
- **veto flag has no effect on Anthropic** — `openai_veto_reasoning_effort` only affects `OpenAiReasoningStep`.
- **reasoning_effort is always stripped** by step 3 if present.
- `openai_extra_body` keys are merged at the top level of the body on the Anthropic route too (applies to both routes per code).

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
| 4. PerModelRule | Sets `body.thinking` to rule's `openai_thinking_shape` **when a reasoning signal is active** (thinking enabled OR reasoning_effort non-disabled). When no signal → no stamp (thinking left untouched). Merges `openai_extra_body` keys at top level if rule has it. |
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

> **PerModelRule interaction:** The "thinking absent + reasoning absent"
> row in the matrix above describes `OpenAiReasoningStep` only. When
> PerModelRuleStep runs first (step 4) and detects no reasoning signal,
> it also skips — leaving `thinking` absent entirely (no
> `{type:"disabled"}` stamp). This prevents 400 errors on strict upstreams
> that reject orphaned disabled-thinking blocks without reasoning_effort.

### PerModelRule detection logic (OpenAI)

`PerModelRuleStep` on OpenAI routes uses OR logic to detect whether a
reasoning signal is active:

```
reasoningActive = isThinkingEnabled(body.thinking) || !isReasoningEffortDisabled(body.reasoning_effort)
```

- `isThinkingEnabled` = thinking present AND not disabled (`{type:"disabled"}`, `{type:"off"}`, `{type:"none"}`, `{enabled:false}`)
- `isReasoningEffortDisabled` = reasoning_effort absent OR `"off"` / `"none"` / `"null"`

When `reasoningActive=true` → stamps `body.thinking` with `openaiThinkingShape`.
When `reasoningActive=false` → **no stamp** (thinking left untouched — clean passthrough).

### Per-model OpenAI result matrix (all toggles on + all 6 rules configured)

**Model configurations:**

| # | Pattern | `openaiThinkingShape` | veto | top-level merge | `effort` | `top_k` | `canDisable` |
|---|---|---|---|---|---|---|---|
| 1 | `umans-kimi-k2.7` | `{type:"enabled", keep:"all"}` | yes | — | `"high"` | — | `false` |
| 2 | `umans-glm-5.2` | `{type:"enabled", clear_thinking:false}` | — | — | `"max"` | `20` | `true` |
| 3 | `umans-coder` | `{type:"enabled", keep:"all"}` | yes | — | `"high"` | — | `false` |
| 4 | `umans-kimi-k3` | `{type:"enabled"}` (bare) | — | — | `"max"` | — | `true` |
| 5 | `umans-flash` | `{type:"enabled"}` (bare) | — | `{enable_thinking, preserve_thinking}` | `"high"` | — | `true` |
| 6 | `umans-qwen3.6-35b-a3b` | `{type:"enabled"}` (bare) | — | `{enable_thinking, preserve_thinking}` | `"high"` | — | `true` |

> `effort`, `top_k`, `canDisable` come from `STAMP_OVERLAY` (code-level, intentionally broad globs). `openaiThinkingShape`, `veto`, top-level merge come from per-model rules (config-level, model-specific patterns).

#### Scenario T: thinking identified (`thinking:{type:"enabled"}`, no `reasoning_effort`)

| Model | `thinking` | `reasoning_effort` | `temp` | `top_k` | top-level merge |
|---|---|---|---|---|---|
| `umans-kimi-k2.7` | `{type:"enabled", keep:"all"}` | absent (veto blocks inject) | `1.0` | — | — |
| `umans-glm-5.2` | `{type:"enabled", clear_thinking:false}` | `"max"` | `1.0` | `20` | — |
| `umans-coder` | `{type:"enabled", keep:"all"}` | absent (veto blocks inject) | `1.0` | — | — |
| `umans-kimi-k3` | `{type:"enabled"}` | `"max"` | `1.0` | — | — |
| `umans-flash` | `{type:"enabled"}` | `"high"` | `1.0` | — | `enable_thinking:true, preserve_thinking:true` |
| `umans-qwen3.6-35b-a3b` | `{type:"enabled"}` | `"high"` | `1.0` | — | `enable_thinking:true, preserve_thinking:true` |

#### Scenario R: reasoning identified (`reasoning_effort:"high"`, no `thinking`)

| Model | `thinking` | `reasoning_effort` | `temp` | `top_k` | top-level merge |
|---|---|---|---|---|---|
| `umans-kimi-k2.7` | `{type:"enabled", keep:"all"}` | `"high"` (kept, veto skips force) | `1.0` | — | — |
| `umans-glm-5.2` | `{type:"enabled", clear_thinking:false}` | `"max"` (forced) | `1.0` | `20` | — |
| `umans-coder` | `{type:"enabled", keep:"all"}` | `"high"` (kept, veto skips force) | `1.0` | — | — |
| `umans-kimi-k3` | `{type:"enabled"}` | `"max"` (forced) | `1.0` | — | — |
| `umans-flash` | `{type:"enabled"}` | `"high"` (forced) | `1.0` | — | `enable_thinking:true, preserve_thinking:true` |
| `umans-qwen3.6-35b-a3b` | `{type:"enabled"}` | `"high"` (forced) | `1.0` | — | `enable_thinking:true, preserve_thinking:true` |

#### Scenario N: neither identified (both `thinking` and `reasoning_effort` absent)

| Model | `thinking` | `reasoning_effort` | `temp` | `top_k` |
|---|---|---|---|---|
| all 6 | absent | absent | — | — |

Clean passthrough. No stamps. No `thinking:{type:"disabled"}` injection.

#### Scenario D: reasoning disabled (`reasoning_effort:"off"`, no `thinking`)

| Model | `thinking` | `reasoning_effort` | `temp` | `top_k` | Why |
|---|---|---|---|---|---|
| `umans-kimi-k2.7` | absent | `"off"` | — | — | PerModelRule no stamp → veto `!hasThinking` → return false |
| `umans-glm-5.2` | absent | `"off"` | — | `20` | canDisable=true → respected. TopK stamps (re defined) |
| `umans-coder` | absent | `"off"` | — | — | PerModelRule no stamp → veto `!hasThinking` → return false |
| `umans-kimi-k3` | absent | `"off"` | — | — | canDisable=true → respected |
| `umans-flash` | absent | `"off"` | — | — | canDisable=true → respected |
| `umans-qwen3.6-35b-a3b` | absent | `"off"` | — | — | canDisable=true → respected |

> GLM gets `top_k=20` in scenario D because `TopKStep` gates on `reasoning_effort !== undefined` (not on whether reasoning is active). Only GLM has `top_k !== null` in its overlay.

### Key points (OpenAI route)

- `reasoning_effort` value comes from `policy.effort`: GLM + kimi-k3 = `"max"`, all others = `"high"`.
- Veto models (kimi-k2.7, coder): `reasoning_effort` never injected (vendor errors on it). Output_config/context_management still stripped, temperature still forced to 1.0 — but only when thinking is enabled (set by PerModelRuleStep).
- Thinking is **preserved** (set by PerModelRuleStep, never deleted by stampReasoning).
- `openai_extra_body` keys merge at the top level of the body on **both** routes (not just OpenAI).
- When no reasoning signal (scenario N/D) → thinking left absent, no `{type:"disabled"}` stamp. Prevents 400 on strict upstreams that reject orphaned disabled-thinking blocks.

---

## Experimental body modifications

These flags are on by default and modify the body outside the 10-step
stamp pipeline.

### `experiment_rewrite_ids` (default: true)

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

### `experiment_strip_omo_reminder` (default: true)

See step 10 (StripOmoReminder) above. Anthropic route only. Removes
`\n[Category+Skill Reminder]` text blocks from `messages[0].content` only;
preserves all other blocks and cache_control breakpoints.

### `experiment_ttft_watchdog` (default: true)

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
      "pattern": "umans-glm-5.2",
      "anthropic_thinking_shape": { "type": "enabled", "clear_thinking": false },
      "openai_thinking_shape": { "type": "enabled", "clear_thinking": false }
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
      "pattern": "umans-qwen3.6-35b-a3b",
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
