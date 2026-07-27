# Accept cold-start classes the proxy cannot fix (subagents + slash commands)

## Status

Accepted.

## Context

Subagent cold starts and slash-command resets are outside the scope of the proxy's breakpoint fix in ADR 0002. Every subagent invocation (`task()`, `explore`, `librarian`, etc.) starts a fresh conversation whose first 1 to 2 requests report `cache_read_input_tokens = 0`.

Capture analysis (`~/umans-gate.db`, 199 captures) showed why these cold
starts are structurally unavoidable given the current system prompt layout:

- Main conversation `system`: `<agent-identity>Sisyphus - Powerful AI Agent
  with orchestration capabilities...` (~60 KB)
- Subagent `system` examples:
  - `You are a strategic technical advisor...` (~88 KB)
  - `You are a title generator. You output ONLY a thread title...` (~2 KB)
  - `You are a codebase search specialist...` (~52 KB)

All five distinct system prompts in the captures share a **large common
suffix**: the env block, `AGENTS.md`, `CLAUDE.md`, `codegraph.md`, MCP
server instructions, the skills list, and the `customize-opencode`
constraints block. This suffix is appended *after* the agent-specific
persona prefix.

Anthropic's `cache_control` hashes the cumulative prefix from request
**start**. Because the persona prefix comes first and differs at byte 0
across agent types, there is no shared cached prefix between main and
subagents. The common suffix at the end is never cacheable across them.

Subagent conversations cache stably from their own turn 3 onward (verified:
id=2398 cr=30464 at 92%, rising to 99% by id=2404). The main conversation
fully recovers its cache when the subagent returns (id=2405: cr=92352,
100% of pre-subagent levels). The cost is exactly 2 cold-start requests per
subagent invocation.

## Context (slash-command resets)

A third class of cold-start drops occurs at slash-command boundaries
(`/diagnosing-bugs`, `/grill-with-docs`, `/setup-matt-pocock-skills`).
Capture analysis compared cache-hit and cache-miss requests at these
boundaries:

- id=2526 (cr=47616, hit) vs id=2528 (cr=0, miss), `/grill-with-docs`
- id=2573 (cr=140800, hit) vs id=2575 (cr=0, miss), `/diagnosing-bugs`

Within each pair: system prompts byte-for-byte identical, system
breakpoint present on both, gaps of 3 and 5 minutes (well within the
1h TTL). Yet the slash-command side misses.

Exactly 2 request headers differ in both pairs: `x-session-id` and
`x-session-affinity`. opencode assigns a new session ID per
slash-command invocation. The upstream (umans-glm-5.2) appears to key
cache lookup by session ID; when it changes, even identical system +
breakpoint within TTL misses.

The proxy already has `src/experiments/rewrite-ids.ts` (gated on
`experimentRewriteIds`, default `false`) that detects and rewrites these
headers. But it is designed for 502-avoidance via salted ID mapping, not
cache normalization; it changes the ID to a *different* value, which
would not help caching.

## Decision

The proxy accepts both subagent cold starts and slash-command resets as architecturally unavoidable.

**Subagents**: the proxy cannot reliably split a system prompt into
`[shared-context, persona]`; the boundary has no consistent marker and
mis-detection would corrupt the prompt. The realistic fix lives in
opencode/oh-my-openagent: restructure the system prompt template so the
**shared context (AGENTS.md, CLAUDE.md, skills, env) comes first, persona
last**. Then every agent would share a cacheable prefix of ~50 KB+; only
the persona tail would cold-start.

**Slash commands**: the proxy could theoretically normalize `x-session-id`
and `x-session-affinity` across slash-command boundaries, but this risks
breaking upstream rate-limiting, abuse detection, or violating the
provider's ToS. The realistic fix is opencode-side: stop assigning a new
session ID on slash-command boundaries. Both fixes are outside this repo.

## Considered options

- **Proxy-side `experiment_reorder_system_prompt` step**: rejected. The
  proxy has no reliable way to detect the persona/context boundary inside
  an opaque system string or array. Mis-detection corrupts the prompt,
  which is worse than the cold start. The proxy's contract is to manage
  `cache_control` placement and stamp fields, not to parse and restructure
  prompt semantics.
- **Restructure opencode's system prompt template**: the correct fix for
  subagent cold starts, but outside this repo. Recorded here so a future
  investigator of "why do subagents still cold-start after ADR 0002?"
  doesn't re-derive the cause. The shared suffix (~50 KB) is the cacheable
  asset; moving it to the front is the win.
- **Proxy-side `experiment_normalize_session_id` step**: rejected. The
  proxy could override `x-session-id`/`x-session-affinity` to a stable
  value across slash-command boundaries, forcing the upstream to treat all
  requests as one session for cache purposes. But this risks breaking
  upstream rate-limiting, abuse detection, or violating the provider's ToS.
  The existing `experimentRewriteIds` infrastructure rewrites IDs for
  502-avoidance, not cache normalization, and cannot be reused as-is.
- **Accept as unavoidable (current)**: chosen. Subagent cold starts cost
  2 turns per invocation; slash-command resets cost 1 turn per command.
  Both are bounded and do not corrupt the main conversation's cache
  (subagents: 100% recovery observed; slash commands: fresh context is
  arguably correct behavior anyway).

## Consequences

- Subagent invocations will continue to show `cache_read_input_tokens = 0`
  on their first 1 to 2 requests. This is expected, not a regression, and
  is not addressed by ADR 0002's restamp.
- Slash-command boundaries will continue to show `cache_read_input_tokens
  = 0` on the command's first request. The prior conversation's cache
  cannot be reused because the upstream keys cache by `x-session-id` and
  opencode assigns a new one per command.
- Main conversation cache is unaffected by subagent invocations; it
  recovers fully when the subagent returns.
- If opencode/oh-my-openagent ever restructures its system prompt template
  to put shared context first, the subagent cold-start cost drops from
  "full re-cache of system + first message" to "re-cache of persona tail
  only." That is the only realistic path to reducing subagent cold-start
  cost.
- If opencode stops assigning a new `x-session-id` on slash-command
  boundaries (or reuses the parent conversation's), slash-command cache
  resets disappear without proxy changes.
- Future investigators should read this ADR and `CONTEXT.md` (`Cold start`
  entry) before proposing proxy-side fixes for subagent cold starts or
  slash-command resets.
