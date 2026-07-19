# 01 — Restamp breakpoints to Layout B

**What to build:** when Claude Code stamping is enabled, Anthropic-route
requests have their `cache_control` breakpoints restamped to Layout B
(`system[0]` + last user message) before forwarding upstream. Mid-session
cache drops caused by breakpoint repositioning stop occurring. The existing
TTL stamp step still stamps `ttl:"1h"` on every breakpoint (now including
the restamped ones), because restamp runs first and the TTL step runs
second.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] Pure function `restampBreakpoints(body)` exists outside the
      `experiments/` directory (it's part of the Claude Code bundle, not
      an experiment). The function is pure (does not mutate input),
      idempotent (applying twice equals applying once), and returns the
      original body reference when nothing changed (so callers can detect
      no-op via reference equality).

- [ ] Algorithm contract honored:
  - Strip `cache_control` from every block in every message's `content`
    array.
  - If `system` is an array: strip `cache_control` from every system
    block except `system[0]`. If `system[0]` is an object and is a
    text-typed block (`type === "text"` or `type` absent) and lacks
    `cache_control`, add `cache_control: { type: "ephemeral" }` (no
    `ttl`).
  - Find the last message with `role === "user"` whose `content` is an
    array. If found, add `cache_control: { type: "ephemeral" }` to its
    last block (no `ttl`).
  - Never write a `ttl` value (the TTL step handles that).
  - Never convert a string `system` or string `content` to an array.
  - Never add a breakpoint to a non-text system block.
  - Return the original body reference when the body is not an object,
    `messages` is not a non-empty array, or no change was made.

- [ ] New `RestampBreakpointsStep` wraps the pure function. Its
      `applies()` gate is `ctx.config.stampClaudeCode && !ctx.isOpenAi` —
      identical to the other Claude Code bundle steps (`CacheTtlStep`,
      `AnthropicBodyStep`, `ContextManagementStep`, etc.). No new config
      field is introduced.

- [ ] `RestampBreakpointsStep` is inserted at position 0 in
      `STAMP_PIPELINE`, before `CacheTtlStep`. The TTL step remains the
      single source of truth for the `ttl:"1h"` value — the restamp step
      reasons only about placement and never writes a `ttl`.

- [ ] On a successful restamp, the step logs at info level with its
      label, HTTP method, and request path — matching the logging
      pattern of the other stamp steps.

- [ ] **Seam A (unit test)**: a new test file exercises the pure
      `restampBreakpoints(body)` function directly. Covers:
  - Tip-riding breakpoints (sys + last assistant + last user) → Layout B
    (sys + last user).
  - No system field → only last-user breakpoint placed.
  - String system (not an array) → system left alone, last-user
    breakpoint placed.
  - No user-role message → only system breakpoint placed (or none if
    no system).
  - Multiple system blocks → only `system[0]` keeps its breakpoint;
    others stripped.
  - `system[0]` without a breakpoint → breakpoint added (if text-typed).
  - `system[0]` that is not text-typed → no breakpoint added.
  - Last user message with string content → no breakpoint placed on it.
  - Empty messages array → no-op, returns original reference.
  - Non-object body → no-op, returns original reference.
  - Idempotency: applying twice produces the same result as applying
    once.
  - No-change case (body already in Layout B) → returns original
    reference.

- [ ] **Seam B (pipeline integration test)**: extend the existing
      pipeline-order characterization test to assert:
  - `RestampBreakpointsStep` is present in `STAMP_PIPELINE`.
  - It is at position 0 (before `CacheTtlStep`).
  - Its `applies()` returns true when `stampClaudeCode: true &&
    !isOpenAi`.
  - Its `applies()` returns false when `stampClaudeCode: false`.
  - Its `applies()` returns false when `isOpenAi: true` (even if
    `stampClaudeCode: true`).
  - When the step fires on an Anthropic request with tip-riding
    breakpoints, the TTL step subsequently stamps `ttl:"1h"` on the
    restamped breakpoints (verifying the restamp→TTL ordering). The
    body that reaches a mock upstream has Layout B breakpoints, each
    carrying `ttl:"1h"`.

- [ ] `bun run typecheck` passes with no errors.
- [ ] `bun run lint` passes with no new warnings.
- [ ] No `as any`, `@ts-ignore`, or `@ts-expect-error` introduced.
- [ ] Existing tests still pass.

## Notes

- **Parent spec**: `.scratch/restamp-breakpoints-layout-b/spec.md`.
- **Source ADR**: `docs/adr/0002-restamp-breakpoints-layout-b.md` —
  contains the full algorithm contract, gating rationale, and pipeline
  position reasoning.
- **Glossary terms** (from `CONTEXT.md`): `Breakpoint repositioning`
  (the behavior being fixed), `Breakpoint`, `Cache hit`, `Cache write`.
- **Prior art for tests**:
  - `test/strip-omo-reminder.test.ts` — direct template for Seam A
    (same pure-function-over-AnthropicBody shape, same "returns original
    reference when nothing changed" contract).
  - `test/stamp-pipeline-order.test.ts` — direct template for Seam B
    (same `makeCtx()` helper, same pipeline-structure assertions).
- **Out of scope**: message truncation (DCP plugin), subagent cold
  starts, slash-command resets, OpenAI-route restamp, dashboard UI
  changes. All documented in the spec and ADRs 0001/0003.
