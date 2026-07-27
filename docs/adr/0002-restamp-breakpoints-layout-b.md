# Restamp cache_control breakpoints to Layout B (system + last user)

## Status

Accepted. Supersedes the rejection in ADR 0001 §"Stabilize historical messages". Implemented in `src/stamp-pipeline.ts` (`RestampBreakpointsStep`).

## Context

The dominant mid-session cache drop is caused by breakpoint repositioning, not by historical message mutation. Capture diffing of 199 consecutive rows in `~/umans-gate.db` showed historical blocks are byte-identical between requests. The harness moves the `cache_control` breakpoint to the rolling message tip each turn (last assistant `tool_use` + last user `tool_result`) and strips it from the previously tipped blocks. Because Anthropic hashes the cumulative prefix through each breakpoint, removing a breakpoint from a mid-prefix block invalidates the hash from that point forward, forcing a partial cache re-read every turn the tip rolls forward.

This behavior is documented as **Breakpoint repositioning** in `CONTEXT.md`. ADR 0001's term "Context compaction" is retired; the separate behavior of historical messages being dropped (e.g. msgs 7→3) is now **Message truncation**.

## Decision

The proxy will restamp `cache_control` breakpoints into **Layout B** before forwarding upstream.

- Strip `cache_control` from every message block (all `messages[i].content[*]`).
- Strip `cache_control` from every system block except `system[0]` (when
  `system` is an array).
- Ensure `system[0]` has `cache_control: { type: "ephemeral" }`, preserved
  if the harness put one there, added if not. Only added when `system[0]`
  is a text-typed block (`type === "text"` or `type` absent).
- Add `cache_control: { type: "ephemeral" }` to the last block of the last
  user-role message whose `content` is an array. If no such message exists,
  the request ships with only the system breakpoint (no message breakpoint).
- No `ttl` value is written by this step. `CacheTtlStep` runs next and
  stamps `ttl:"1h"` on every breakpoint it finds.
- Total breakpoints after restamp: 2 (system + last user) when both are
  placeable; 1 (system only) when no eligible user message exists.

**Pipeline position**: `RestampBreakpointsStep` runs *first*, before
`CacheTtlStep`. This keeps `CacheTtlStep` as the single source of truth for
the `ttl:"1h"` value; the restamp step reasons only about *placement* and
never writes a `ttl`. The benign interaction with `StripOmoReminderStep`
(which runs later and may remove a block from `messages[0]`) is accepted:
it only matters on single-message requests, which are cold starts with no
cache to protect.

**Gating**: `RestampBreakpointsStep` is part of the Claude Code stamp
bundle, not a standalone experiment. Its `applies()` gate is
`ctx.config.stampClaudeCode && !ctx.isOpenAi`, identical to `CacheTtlStep`,
`AnthropicBodyStep`, `ContextManagementStep`, etc. No new config field is
introduced. Rationale: the OpenAI route has its own stamp bundle
(`stamp_reasoning_effort_enabled`); if restamp were independently
toggleable, enabling it without the matching route setup would introduce
inconsistencies. Bundling with Claude Code style keeps the two stamp bundles
coherent: when Claude Code style is on, restamp is on; when it's off,
restamp is off.

## Considered options

- **Layout A (current, no-op)**: rejected. Tip-riding breakpoints are
  the documented cause of the drops. Keeping the status quo preserves the
  bug.
- **Layout B (chosen)**: system + last user. Simplest correct
  implementation; matches Anthropic guidance directly; gives up the
  fragile tip cache that was causing the drops.
- **Layout C (system + stable mid-prefix + last user)**: rejected. The
  proxy cannot predict which mid-prefix blocks the harness will mutate
  next, so any choice of "stable" mid block is speculative and may
  itself be invalidated. Adds complexity for unverified gain.
- **Layout D (system + last stable tool_result + last user)**: rejected
  for the same reason as C; "last stable" is not knowable at the proxy.
- **Reject the restamp entirely (keep ADR 0001's stance)**: rejected.
  ADR 0001's rejection rested on "the proxy cannot lie about request
  body contents; forwarding the harness's mutated body is the only
  semantically correct behavior." That premise does not hold when the
  body is not mutated, only the breakpoint annotation moves. Restoring
  a breakpoint the harness removed is a materially different intervention
  from fabricating content, and it is what Anthropic's own caching
  guidance prescribes.

## Consequences

- When enabled, mid-session cache drops caused by breakpoint
  repositioning should disappear. The system prefix caches stably; the
  last-user-message breakpoint re-caches each turn (expected, one write
  per turn).
- The assistant tool corpus between system and last user no longer has
  its own breakpoint. Conversations with a large stable tool corpus may
  see a *smaller* cached portion per turn than today's fragile
  "larger" portion. The trade is stability for size, measured to be
  worth it given today's drops lose 27K+ tokens per tip shift.
- Enabled automatically when `stamp_claude_code_enabled` is true (part
  of the Claude Code stamp bundle, not a standalone experiment). No
  new config field; the default behavior changes only for users who
  already have Claude Code style enabled, which is the intended audience
  (the drops only affect Anthropic-route traffic that Claude Code style
  targets anyway).
- ADR 0001's cause #2 should be read as "Breakpoint repositioning" per
  the corrected `CONTEXT.md` glossary, not as "context compaction /
  message mutation."

## Verification

- **Seam A (unit)**: `test/restamp-breakpoints.test.ts` tests the pure
  `restampBreakpoints(body)` function directly. Covers every edge case:
  tip-riding breakpoints → Layout B, no system, string system, no user
  message, multiple system blocks, etc. This is the regression test that
  goes red before the fix and green after.
- **Seam B (pipeline integration)**: extend `test/stamp-pipeline-order.test.ts`
  to assert `RestampBreakpointsStep` is in `STAMP_PIPELINE` at position 0,
  gated on `stampClaudeCode && !isOpenAi`, and that `CacheTtlStep` runs
  after it (verifying the `ttl` value lands on the restamped breakpoints).
- **Seam C (e2e through mock upstream), skipped**: redundant with B, which
  already captures what reaches the upstream via the mock.

  TDD order: write A → watch fail → implement `restampBreakpoints` → watch A
  pass → add B → watch B pass.

  Pure function lives at `src/restamp-breakpoints.ts` (not `experiments/`),
  because restamp is part of the Claude Code bundle, not an experiment.
