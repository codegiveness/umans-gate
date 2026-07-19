# umans-gate

A capture proxy for LLM APIs (Anthropic + OpenAI-compatible). It intercepts
traffic, stamps `ttl` onto `cache_control` ephemeral blocks, stores
requests/responses in SQLite, and serves a live inspection dashboard.

## Language

### Caching

**Cache hit**:
A request whose prefix (system + tools + messages, up to a `cache_control`
breakpoint) byte-for-byte matches a prior cache entry written within the TTL.
Reported by the upstream API as `cache_read_input_tokens > 0`.
_Avoid_: cache match, cached request.

**Cache write**:
The first request that establishes a cache entry for a given prefix. Reported
as `cache_creation_input_tokens > 0`. A cache write is the seeding operation;
the same request cannot also be a cache hit (writes happen during response
generation, not before).
_Avoid_: cache creation, cache store, cache populate.

**Cache miss**:
A request where no prior cache entry exists for the prefix (cold start, TTL
expired, or prefix changed). Reported as `cache_creation_input_tokens = 0 AND
cache_read_input_tokens = 0`. Distinct from a cache write (which intentionally
establishes a new entry) — a miss is when even the write doesn't happen
(prefix below model minimum, or no `cache_control` breakpoint).
_Avoid_: cache fault, uncached.

**Breakpoint**:
A content block annotated with `cache_control: { type: "ephemeral", ttl:
"1h" }`. Anthropic writes one cache entry per breakpoint, hashing the
cumulative prefix from request start through that block. Maximum 4 per
request; opencode places 3 (system + 2 message-tip).
_Avoid_: cache marker, cache point.

**Lookback window**:
The 20-block window Anthropic searches backward from a breakpoint for a
prior cache write. If no write exists within 20 blocks, the breakpoint is a
miss regardless of prefix stability.
_Avoid_: search window, cache scan range.

### Metrics

**cached_pct**:
The aggregate cache metric on the Performance tab. Computed in SQL
(`src/usage/ddl.ts`) as `SUM(cache_read_tokens) / SUM(total_input_tokens) *
100` over the latest 100 done captures per model. Structurally cannot reach
100% because `total_input_tokens` includes fresh `input_tokens` (the new user
message) on every request.
_Avoid_: cache ratio, hit ratio, cache efficiency.

**Cache hit rate (per-row)**:
The per-capture badge shown in capture rows. Computed as
`fmtCachePct(cache_read_tokens, total_input_tokens)` — same ratio as
`cached_pct` but per row. Cannot reach 100% for the same structural reason.
_Avoid_: cache percentage, row hit rate.

**total_input_tokens**:
`input_tokens + cache_creation_input_tokens + cache_read_input_tokens`.
The full input bill for a request. Used as the denominator in both
`cached_pct` and the per-row badge.
_Avoid_: prompt tokens, input total.

**input_tokens**:
The uncached portion of input — the new user message plus any prefix not
covered by a cache hit or cache write. Always > 0 on any real request,
which is why no cache hit rate formula using `total_input_tokens` as the
denominator can reach 100%.
_Avoid_: fresh tokens, new tokens.

### Architecture

**Stop gate**:
The concurrency admission layer in `src/limiter/` — `ConcurrencyGate` (a
semaphore) composed with a `CircuitBreaker`. Acquires a permit before
forwarding upstream; rejects with `GateError` codes (`circuit_open`,
`queue_full`, `timeout`, `aborted`) when the breaker is open or the queue
overflows. Gate-rejected captures are stored with `status_source: "gate"`
and `gate_reason` set, and are excluded from `cached_pct` by the
`usage_missing = 0` filter. The stop gate does not influence cache hit rate
computation.
_Avoid_: limiter, circuit breaker (those are components), admission control.

**Breakpoint repositioning**:
A harness-side behavior (opencode) where `cache_control` breakpoints are
placed on the rolling message tip — the last assistant `tool_use` and last
user `tool_result`. Each turn, as new messages arrive, the harness *strips*
the breakpoint from the previously-tip blocks and re-adds it to the new tip.
Content is byte-identical; only the `cache_control` field moves. Because
Anthropic hashes the cumulative prefix through each breakpoint, removing a
breakpoint from a mid-prefix block invalidates the hash from that point
forward, forcing a partial cache re-read on the next request. Not a proxy
behavior; the proxy faithfully forwards whatever the harness sends.
_Avoid_: cache_control stripping, breakpoint moving, tip shifting.

**Message truncation**:
A harness-side behavior (opencode or the DCP plugin) where historical
messages are dropped from the request body mid-session — e.g. msgs
shrinking 7→3 or 11→7 between consecutive requests. Distinct from
breakpoint repositioning: here the *content* itself is removed, not just
the breakpoint annotation. Invalidates the cache from the truncation
point forward. Not a proxy behavior; the proxy faithfully forwards
whatever the harness sends.

Mitigation is harness-side: in `~/.config/opencode/dcp.jsonc`, raise
`compress.minContextLimit` / `compress.maxContextLimit` (e.g. to `60%` /
`75%`) so compression triggers less often, or set `compress.mode: "off"`
and rely only on `deduplication` + `purgeErrors`. Every compression event
is a cache drop. See ADR 0001.
_Avoid_: context compression, message compaction, summarization.

**Cold start**:
The first request of a new conversation (or a new subagent invocation
with a different system prompt). Always reports `cache_read_input_tokens
= 0` because no cache entry exists yet. Architecturally unavoidable — the
cache write happens during the first response, so the seeding request
cannot read it.

For subagents specifically: the cold start is compounded by system prompt
structure. The agent-specific persona prefix comes first and differs at
byte 0 across agent types, so even though main and subagent system prompts
share a large common suffix (AGENTS.md, CLAUDE.md, skills, env), that
suffix is never cacheable across agents — Anthropic hashes from request
start. See ADR 0003.
_Avoid_: first-turn miss, warmup miss.

**Session-scoped cache**:
The upstream (umans-glm-5.2) appears to key cache lookup by `x-session-id`
request header. opencode assigns a new `x-session-id` (and matching
`x-session-affinity`) per slash-command invocation, so even when the system
prompt, breakpoint, and TTL are all identical and within window, the
slash-command's first request misses the cache established by the parent
conversation. Not a proxy behavior; the proxy forwards whatever headers
the harness sends. See ADR 0003.
_Avoid_: session cache, per-session cache.
