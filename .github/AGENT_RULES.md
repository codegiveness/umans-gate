# AGENT_RULES.md

AI agent behavioral rules for the umans-gate codebase. Read before writing
any code. These are recurring mistakes that are easy to get wrong.

## 1. Dashboard must be built before integration tests

Integration tests in `test/` spawn `bun src/cli.ts` via
`test/helpers/proxy.ts`. The CLI embeds dashboard assets from
`dashboard/dist/`. If `dashboard/dist/` does not exist, the proxy fails to
start with:

```
Cannot find module './../dashboard/dist/assets/select-D5m3WZdd.js'
from 'src/embedded-assets.ts'
```

This causes `beforeAll` hooks to time out (5s) and all integration tests in
that file to fail with `TypeError: undefined is not an object`.

**Always run `cd dashboard && bun run build` before running integration
tests** if the dashboard dist is missing or stale. The build takes <1s.

## 2. Adding a required field to an exported interface breaks all consumers

When you add a new required field to an exported interface like
`StampPolicy`, every object that constructs that type must be updated:

- The `STAMP_OVERLAY` entries in `stamp-catalog.ts`
- Test helpers that construct the type (e.g. `makeEntry` in
  `model-policy-glm-stamp.test.ts` calls `matchStampOverlay()` which
  returns the overlay; those are fine, but `catalogWith` in
  `stamp-catalog.test.ts` calls `parseModelInfoResponse` which must
  populate the new field)
- Any test using `toEqual` on the type must include the new field

**Run `bun run typecheck` immediately after adding a required field.** Do
not wait until the end. The type errors will tell you every file that
needs updating.

## 3. Unused imports trigger lint failures

Biome enforces no-unused-imports. After refactoring, if you remove the
last usage of an imported symbol, you must also remove the import. Common
when:

- You import a type for a test that no longer uses it
- You import a constant (e.g. `STAMP_OVERLAY`) for a test assertion that
  was rewritten to not need it

**Run `bun run lint` after every test file edit.** The `lint:fix` command
handles safe removals automatically.

## 4. Biome formatting: long function calls break differently

Biome reformats multi-argument function calls. If you write:

```typescript
if (stampThinking(b, {
  maxTokens: true,
  thinking: true,
  outputConfig: { effort: policy.effort },
  policy,
})) {
```

Biome will reformat it to:

```typescript
if (
  stampThinking(b, {
    maxTokens: true,
    thinking: true,
    outputConfig: { effort: policy.effort },
    policy,
  })
) {
```

**Always run `bun run lint:fix` after editing source files** to avoid
formatter-only CI failures.

## 5. Edit boundaries: don't lose adjacent code

When replacing a block of code, the `oldString` must be unique. If the old
string appears in multiple places (e.g. a closing `});` followed by a test
header), the edit may match the wrong location and silently delete a test
function header.

**After every edit to a test file, read the 10 lines above and below the
edited region** to confirm no adjacent code was lost.

## 6. Thinking stamping rules (ADR-0011)

When `stampClaudeCode` is enabled on Anthropic routes, **all body stamps are
gated on thinking being enabled** (present and not disabled). Only TTL/cache
control stamping is independent of thinking.

When thinking is **absent or disabled** (and respected):

- `max_tokens`: **not stamped** (original value preserved)
- `thinking`: **not injected**
- `output_config`: **not stamped**
- `temperature`: **not forced**
- `top_k`: **not stamped**
- `context_management`: **not stamped**
- TTL on `cache_control` ephemeral blocks: **always stamped**

When thinking is **enabled** (present and not disabled):

- `thinking` present + disabled form + `canDisableThinking: true` → respected.
- `thinking` present + disabled form + `canDisableThinking: false` (Kimi,
  Coder) → forced to the resolved `thinkingShape`.
- `thinking` present + any non-disabled shape → forced to the resolved
  `thinkingShape`.
- `max_tokens`: stamped from policy
- `output_config`: stamped from policy effort
- `temperature`: forced to 1.0
- `top_k`: stamped for GLM models
- `context_management`: stamped
- `reasoning_effort`: **always stripped** from Anthropic bodies

### Child-toggle gating (ADR-0019)

The `thinkingShape` forced above is resolved by
`applyModelSpecificThinkingOverride(policy, modelName, config)`, which
checks the child toggles in order (first match wins):

- `stamp_glm_5_2_thinking_enabled` ON + model name contains `"5.2"` →
  GLM Preserved Thinking `{ type: "enabled", clear_thinking: false, budget_tokens: 32000 }`
- `stamp_kimi_k2_7_code_thinking_enabled` ON + model name contains
  `"k2.7-code"` → Kimi Preserved Thinking
  `{ type: "enabled", keep: "all", budget_tokens: 32000 }`
- Otherwise → `{ type: "adaptive" }` (adaptive fallback)

When a child toggle is OFF or the version does not match, the shape is
`{ type: "adaptive" }`, even for models whose overlay declares a
family-specific shape. This is a deliberate behavior change: the previous
unconditional family-specific shapes are now opt-in via the child toggles.

`canDisableThinking` is **not overridden** by the child toggles. It stays
from the resolved overlay policy (GLM=true, Kimi=false). This means a
client-sent disabled thinking block on a Kimi request is still forced (to
the overridden shape when the Kimi child is ON, or to adaptive when OFF).

`reasoning_effort` is never stamped on Kimi K2.7-Code (K3-only feature).
The existing `reasoning_effort` stripping on Anthropic routes handles
this regardless of child toggle state.

`canDisableThinking` comes from `/v1/models/info` `reasoning.can_disable`,
overridden at parse time. See ADR-0011 for the full truth table.

## 7. OpenAI reasoning_effort stamping rules (ADR-0011)

When `stampReasoningEffort` is enabled (non-null) on OpenAI routes:

- `reasoning_effort` absent + `thinking` absent → do nothing (respect
  absence).
- `reasoning_effort` absent + `thinking` enabled → **inject**
  `reasoning_effort` from `policy.effort` (`"max"` for GLM, `"high"` for
  others). Strip `thinking`.
- `reasoning_effort` absent + `thinking` disabled → respect (leave alone).
- `reasoning_effort` present + disabled value (`off`/`none`/`null`) +
  `canDisableThinking: true` → respect.
- `reasoning_effort` present + disabled value +
  `canDisableThinking: false` (Kimi, Coder) → **force** to `policy.effort`.
- `reasoning_effort` present + any other value → **force** to
  `policy.effort`.
- When `reasoning_effort` is present or injected, `thinking` is
  **stripped**.
- When `reasoning_effort` is active, `output_config` and
  `context_management` are **stripped** (Anthropic-specific fields have no
  place on an OpenAI route).
- When `reasoning_effort` is active, `temperature` is **forced to 1.0**
  (reasoning models reject temperature != 1.0).

The target effort is `policy.effort`, NOT the
`STAMP_REASONING_EFFORT_VALUE` config constant (which is always `"high"`).
GLM models get `"max"`.

## 8. Don't re-verify codegraph results with grep

CodeGraph is a full AST parse. Its results are authoritative. Re-checking
with grep is slower, less accurate, and wastes context. Trust the first
codegraph result. If a file shows a staleness banner, Read only that specific
file.

## 9. Section dividers in test files are pre-existing style

The `// ─── Section Name ───` comments in test files match the existing
convention (see `stamp-pipeline-order.test.ts`). They are not new
docstrings. Do not remove them when the comment hook fires.
