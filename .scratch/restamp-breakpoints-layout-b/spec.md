# Restamp cache_control breakpoints to Layout B

Status: ready-for-agent

## Problem Statement

When a harness (opencode) sends Anthropic API requests through umans-gate,
it places `cache_control` breakpoints on the **rolling message tip** — the
last assistant `tool_use` block and the last user `tool_result` block. Each
turn, as new messages arrive, the harness strips the breakpoint from the
previously-tip blocks and re-adds it to the new tip. The content of the
blocks is byte-identical; only the `cache_control` field moves.

Because Anthropic hashes the cumulative prefix through each breakpoint,
removing a breakpoint from a mid-prefix block invalidates the hash from
that point forward. The result is a partial cache re-read every turn the
tip rolls forward — observed in production captures as `cache_read_tokens`
dropping from ~46K to ~18K between consecutive requests in the same
conversation, a loss of ~27K tokens of cached prefix per tip shift.

This is the dominant mid-session cache hit rate drop. It occurs on every
multi-turn Anthropic-route request when Claude Code stamping is enabled.

## Solution

The proxy will restamp `cache_control` breakpoints into **Layout B**
before forwarding upstream:

- Strip `cache_control` from every message block.
- Strip `cache_control` from every system block except `system[0]`.
- Ensure `system[0]` has `cache_control: { type: "ephemeral" }` — preserved
  if the harness put one there, added if not (only when `system[0]` is a
  text-typed block).
- Add `cache_control: { type: "ephemeral" }` to the last block of the last
  user-role message whose `content` is an array. If no such message
  exists, the request ships with only the system breakpoint.
- No `ttl` value is written by this step — the existing TTL stamp step
  runs next and stamps `ttl:"1h"` on every breakpoint it finds.
- Total breakpoints after restamp: 2 (system + last user) when both are
  placeable; 1 (system only) when no eligible user message exists.

This matches Anthropic's documented prompt-caching best practice:
breakpoints at the end of stable prefixes (system prompt) and on the last
user message, not on the rolling assistant/tool tip.

## User Stories

1. As a proxy user with Claude Code stamping enabled, I want mid-session
   cache hits to stay stable across turns, so that I'm not paying to
   re-cache the same prefix every request.
2. As a proxy user, I want the restamp to apply automatically when Claude
   Code stamping is on, so that I don't have to configure a separate flag.
3. As a proxy user on the OpenAI-compatible route, I want restamp to stay
   off, so that my OpenAI-route requests are not affected by
   Anthropic-specific breakpoint logic.
4. As a proxy user, I want the restamp to preserve the system prompt's
   breakpoint, so that the stable system prefix remains cached across
   turns.
5. As a proxy user, I want the restamp to place a breakpoint on my last
   user message, so that the new user content gets its own cache write
   each turn (expected, one write per turn).
6. As a proxy user whose harness sends a string system prompt (not an
   array of blocks), I want the restamp to leave the system field alone,
   so that the proxy doesn't restructure my prompt's shape.
7. As a proxy user whose harness sends a string user message (not an
   array of blocks), I want the restamp to leave that message alone, so
   that the proxy doesn't restructure my message's shape.
8. As a proxy user whose harness sends a system array with multiple
   blocks, I want the restamp to keep only `system[0]`'s breakpoint, so
   that the 4-breakpoint budget isn't consumed by extra system blocks.
9. As a proxy user whose request has no eligible last-user message (e.g.
   all messages have string content), I want the request to ship with
   only the system breakpoint, so that the proxy doesn't fabricate a
   message breakpoint it can't correctly place.
10. As a proxy user, I want the `ttl:"1h"` value to be stamped by the
    existing TTL step (not by the restamp step), so that there's a single
    source of truth for the TTL value.
11. As a proxy maintainer, I want the restamp step to run before the TTL
    step in the pipeline, so that the TTL step sees the restamped
    breakpoints and stamps them.
12. As a proxy maintainer, I want the pure restamp function to be tested
    independently of the pipeline, so that edge cases are covered cheaply
    and deterministically.
13. As a proxy maintainer, I want the pipeline integration to be
    characterized in a single test, so that step ordering and gating are
    locked against regressions.
14. As a future investigator of cache hit rate drops, I want the restamp
    step's behavior to be logged on the proxy's structured log, so that I
    can confirm from logs that the step fired on a given request.
15. As a future investigator, I want the ADR and glossary to explain why
    the proxy restamps breakpoints, so that I don't propose reverting it
    thinking it's a bug.

## Implementation Decisions

### New module: pure restamp function

A new module exports a pure function `restampBreakpoints(body)` that
takes a parsed Anthropic request body and returns a new body with
breakpoints restamped to Layout B. The function:

- Does not mutate its input (returns a new object, like the existing
  `stripOmoReminder` pure function).
- Is idempotent (applying twice produces the same result as applying
  once).
- Preserves all content blocks, all text, all `type` fields, and all
  other fields. It only touches `cache_control`.
- Returns the original body reference when nothing changed, so callers
  can cheaply detect "no change" via reference equality (same pattern as
  `stripOmoReminder`).

The function lives outside the `experiments/` directory because restamp
is part of the Claude Code stamp bundle, not a standalone experiment.

### New pipeline step: RestampBreakpointsStep

A new `StampStep` wraps the pure function. Its `applies()` gate is
identical to the other Claude Code bundle steps:

```
ctx.config.stampClaudeCode && !ctx.isOpenAi
```

No new config field is introduced. The step is enabled automatically when
Claude Code stamping is enabled; it's off when stamping is off or on the
OpenAI route.

The step's `apply()` calls the pure function, copies the changed fields
back to the original body in place (same in-place mutation contract as
the other steps), logs that restamp fired, and returns whether a change
was made.

### Pipeline position

`RestampBreakpointsStep` is inserted at **position 0** in `STAMP_PIPELINE`,
before `CacheTtlStep`. Current order:

```
1. CacheTtlStep
2. AnthropicBodyStep
3. ContextManagementStep
4. OpenAiReasoningStep
5. TopKStep
6. TemperatureStep
7. StripOmoReminderStep
```

New order:

```
1. RestampBreakpointsStep  ← new, runs first
2. CacheTtlStep            ← stamps ttl on whatever breakpoints exist
3. AnthropicBodyStep
4. ContextManagementStep
5. OpenAiReasoningStep
6. TopKStep
7. TemperatureStep
8. StripOmoReminderStep
```

Running first keeps `CacheTtlStep` as the single source of truth for the
`ttl:"1h"` value — the restamp step reasons only about *placement* and
never writes a `ttl`.

### Interaction with StripOmoReminderStep

`StripOmoReminderStep` runs later in the pipeline and may remove a text
block from `messages[0]`. If `messages[0]` was the last user message
(single-message requests, e.g. subagent cold starts with `msgs=1`), then
stripping that block could remove the block restamp just put a breakpoint
on. This interaction is accepted: it only matters on single-message
requests, which are cold starts with no cache to protect.

### Algorithm contract

The `apply()` method's behavior:

1. If `body` is not an object or is null, return false (no-op).
2. If `body.messages` is not a non-empty array, return false (no-op).
3. Strip `cache_control` from every block in every message's `content`
   array.
4. If `body.system` is an array: strip `cache_control` from every system
   block except `system[0]`. If `system[0]` is an object and is a
   text-typed block (`type === "text"` or `type` absent) and lacks
   `cache_control`, add `cache_control: { type: "ephemeral" }` (no `ttl`).
5. Find the last message with `role === "user"` whose `content` is an
   array. If found, add `cache_control: { type: "ephemeral" }` to its
   last block (no `ttl`).
6. Return whether any change was made.

The step never writes a `ttl` value. The step never converts a string
`system` or string `content` to an array. The step never adds a
breakpoint to a non-text system block.

### Logging

On a successful restamp, the step logs at info level with its label,
the HTTP method, and the request path — matching the logging pattern of
the other stamp steps.

### Configuration

No new config field. The step's applicability is gated entirely on the
existing `stampClaudeCode` flag (and `!isOpenAi`). Users who already
have Claude Code stamping enabled will get restamp automatically; users
who have it disabled are unaffected.

### Architectural decision

This is recorded as ADR 0002 (`docs/adr/0002-restamp-breakpoints-layout-b.md`),
which supersedes the rejection in ADR 0001's "Stabilize historical
messages" considered option. ADR 0001's rejection rested on the premise
that the harness mutates historical message content; capture analysis
showed the content is byte-identical and only the `cache_control` field
moves. Restoring a breakpoint the harness removed is materially different
from fabricating content.

The glossary in `CONTEXT.md` was corrected: the old "Context compaction"
term (which described the wrong mechanism) was retired and replaced with
two precise terms — `Breakpoint repositioning` (this spec's target) and
`Message truncation` (a separate DCP-plugin behavior, out of scope here).

## Testing Decisions

### What makes a good test

Tests should verify external behavior (what the body looks like after the
step runs), not implementation details (which internal helper was called,
whether a new object was allocated vs. in-place mutation). The pure
function's contract is its input-output mapping; the pipeline step's
contract is its position, gating, and interaction with the TTL step.

### Seam A — unit test of the pure function

A new test file exercises the pure `restampBreakpoints(body)` function
directly. Covers:

- Tip-riding breakpoints (sys + last assistant + last user) → Layout B
  (sys + last user).
- No system field → only last-user breakpoint placed.
- String system (not an array) → system left alone, last-user breakpoint
  placed.
- No user-role message → only system breakpoint placed (or none if no
  system).
- Multiple system blocks → only `system[0]` keeps its breakpoint; others
  stripped.
- `system[0]` without a breakpoint → breakpoint added (if text-typed).
- `system[0]` that is not text-typed → no breakpoint added.
- Last user message with string content → no breakpoint placed on it.
- Empty messages array → no-op, returns original reference.
- Non-object body → no-op, returns original reference.
- Idempotency: applying twice produces the same result as applying once.
- No-change case (body already in Layout B) → returns original reference.

Prior art: `test/strip-omo-reminder.test.ts` is the direct template —
same pure-function-over-AnthropicBody shape, same "returns original
reference when nothing changed" contract.

### Seam B — pipeline integration test

Extend the existing pipeline-order characterization test to assert:

- `RestampBreakpointsStep` is present in `STAMP_PIPELINE`.
- It is at position 0 (before `CacheTtlStep`).
- Its `applies()` returns true when `stampClaudeCode: true && !isOpenAi`.
- Its `applies()` returns false when `stampClaudeCode: false`.
- Its `applies()` returns false when `isOpenAi: true` (even if
  `stampClaudeCode: true`).
- When the step fires, the TTL step subsequently stamps `ttl:"1h"` on
  the restamped breakpoints (verifying the restamp→TTL ordering).

Prior art: `test/stamp-pipeline-order.test.ts` is the direct template —
same `makeCtx()` helper, same pipeline-structure assertions.

### Out of scope: e2e through mock upstream

A full end-to-end test through the proxy against a mock upstream was
considered and rejected as redundant with Seam B, which already verifies
the pipeline wiring. The only thing e2e adds is "the upstream actually
receives the body," but Seam B verifies the equivalent at the pipeline
level.

## Out of Scope

- **Message truncation (DCP plugin compression)** — separate behavior
  where the DCP plugin drops historical messages mid-session. Mitigation
  is harness-side (tune `dcp.jsonc` thresholds). Documented in
  `CONTEXT.md` under `Message truncation`. Not addressed by this spec.
- **Subagent cold starts** — the first 1–2 requests of a subagent
  invocation always miss because subagent system prompts differ at byte
  0 from the main conversation's, so no shared cached prefix exists.
  Accepted as unavoidable; documented in ADR 0003.
- **Slash-command resets** — opencode assigns a new `x-session-id` per
  slash-command invocation; the upstream appears to key cache lookup by
  session ID. Accepted as unavoidable at the proxy layer; documented in
  ADR 0003 and `CONTEXT.md` under `Session-scoped cache`.
- **System prompt restructuring** — moving the shared context
  (AGENTS.md, CLAUDE.md, skills, env) to the front of the system prompt
  so main and subagents share a cacheable prefix. This is the realistic
  fix for subagent cold starts but lives in opencode/oh-my-openagent,
  not this repo.
- **OpenAI-route restamp** — `cache_control` is Anthropic-only. The
  restamp step's `applies()` gate excludes OpenAI-route requests. No
  equivalent work is needed or possible on the OpenAI route.
- **Dashboard UI changes** — no dashboard fields are added (no new
  config flag). The restamp step's effect is observable in the existing
  capture view (the request body shown in the inspector reflects the
  restamped breakpoints) and in the existing cache hit rate metrics.
- **Regression test against live upstream** — not needed; the
  mechanism is clear from capture analysis and the unit + pipeline tests
  verify the contract.

## Further Notes

- **ADR 0001 relationship**: ADR 0001 ("Accept cache hit rate
  instability") attributed mid-session drops to "harness context
  compaction that mutates historical messages." Capture analysis showed
  the premise was wrong — content is byte-identical, only the
  `cache_control` field moves. ADR 0002 supersedes ADR 0001's rejection
  of "Stabilize historical messages." ADR 0001 is left as-is; ADR 0002's
  "supersedes" note points there. The corrected mechanism is documented
  in `CONTEXT.md` under `Breakpoint repositioning`.

- **Expected cache hit rate impact**: when restamp is enabled, mid-session
  cache drops caused by breakpoint repositioning should disappear. The
  system prefix caches stably; the last-user-message breakpoint re-caches
  each turn (expected, one write per turn). The assistant tool corpus
  between system and last user no longer has its own breakpoint, so
  conversations with a large stable tool corpus may see a *smaller*
  cached portion per turn than today's fragile "larger" portion. The
  trade is stability for size — measured to be worth it given today's
  drops lose 27K+ tokens per tip shift.

- **Cold starts and slash-command resets will still occur** after this
  spec ships. Those are documented in ADR 0003 and are not regressions.

- **Verification after implementation**: re-run the capture-diff feedback
  loop from the original diagnosis against new captures taken with
  restamp enabled. The loop should show zero `Breakpoint repositioning`
  drops on main-conversation multi-turn requests. The loop script was
  deleted at the end of the diagnosis phase; it can be reconstructed
  from the diagnosis ADR's description if needed.
