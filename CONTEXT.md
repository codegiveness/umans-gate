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

### Stamping

**Stamp policy**:
The per-model tuning values applied to a request body by the stamp
pipeline: `max_tokens`, `effort` ("high" or "max"), `thinking` (whether
to inject `{ type: "adaptive" }`), and `top_k` (null or a number).
Distinct from model capabilities (upstream-reported, e.g.
`max_completion_tokens`, `reasoning.supported`) — stamp values are
proxy-specific tuning that may differ from upstream limits. Resolved
via `resolveStampPolicy(modelName, catalog)`, which looks up the
model in the parsed catalog's `stamps` field.
_Avoid_: stamp config, stamp values, model tuning.

**Stamp overlay**:
The local declarative table mapping model-family patterns (e.g.
`"umans-glm*"`) to stamp policies, merged into `ParsedModelInfo` at
`parseModelInfoResponse()` time. The overlay owns the proxy-specific
tuning; the upstream `/v1/models/info` owns the capabilities. Adding
a new model family is a single row in the overlay, not a code change.
_Avoid_: stamp table, stamp mapping, model overrides.

### Architecture

**TTFT watchdog**:
A wall-clock timer started at fetch initiation; fires if no first chunk
arrives from `upstream.body` within `ttft_timeout_ms`. Distinct from the
absolute `upstream_timeout_ms` (5-min ceiling on the whole fetch lifecycle)
and from the semantic `ttft_ms` metric (first `content_block_delta` for
Anthropic, first non-empty delta for OpenAI — computed post-hoc from parsed
SSE). The watchdog races the existing `firstChunkSent` flag in the
`TransformStream.transform` callback — same perception, no dual concept. When
the watchdog fires, the fetch is aborted (distinguishable from client-abort
and absolute-timeout) and a gated retry may follow.
_Avoid_: first-byte timeout, stream timeout (those belong to LiteLLM/kiro).

**TTFT retry**:
A retry triggered by TTFT-watchdog timeout, as distinct from a 502/529
rewrite-id retry. The retry reuses the original permit (single-release
contract preserved) and is exempt from the rate limiter (the original token
was already consumed). Gated by upstream-load signals: breaker state, gate
saturation, and recent retry-failure rate. When the gate suppresses retry,
the client gets a 504.
_Avoid_: stream retry, first-byte retry.

**Attempt**:
A single upstream fetch within a TTFT-retry lifecycle. Attempt 1 is the
original fetch; attempt 2 is the same-key retry; attempt 3 is the
rewrite-id escalation (when eligible). The WS `retryAttempt` field
counts retries, not attempts — `retryAttempt: 1` = attempt 2 in flight.
Distinct from "request" (the client-initiated operation, which may
span multiple attempts under one capture row).
_Avoid_: try, fetch number, run.

**Retry state**:
The live phase of a TTFT-retry lifecycle as seen by the dashboard:
`cooldown` (between attempts, waiting out `ttft_retry_cooldown_ms`),
`retry N` (attempt N+1 fetch in flight), `retried` (terminal — the
request completed after at least one retry). Surfaced as per-row
indicators matching NN/g's "Indicator" pattern (conditional, contextual,
passive). Distinct from the final `x-proxy-retry-attempt` /
`x-proxy-ttft-exceeded` headers, which arrive only with the response.
_Avoid_: retry status, retry phase.

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

**Permit**:
The concurrency slot lease returned by `ConcurrencyGate.acquire()`. A
permit is acquired before forwarding upstream and must be released exactly
once. Release paths (all idempotent via `permitReleased` flag):
1. `TransformStream.flush()` — normal stream completion.
2. `onAbort` listener on `req.signal` — client disconnect.
3. `onAbort` listener on `upstreamSignal` — upstream timeout/client-abort
   propagated to the fetch signal (`AbortSignal.any([req.signal,
   ttftController?.signal, AbortSignal.timeout(upstreamTimeoutMs)])`).
   Fires when the upstream hangs after the Response has been returned to
   Bun.serve (the `req.signal` alone does not abort in this case).
4. `finally` block if streaming never started (`!streamingStarted`).
5. Per-request watchdog timer — safety net that fires at
   `upstream_timeout_ms + 5s` if none of the above fired. Catches
   pathological cases where the stream errors but no signal aborts.
A permit has a `weight` (scaled by `SCALE=1000`) and an `intention`
(`"main"` or `"vision"`). Releases are batched and deferred by
`release_cooldown_ms` (default 1000ms) — the slot counter decrements after
the cooldown timer fires, not immediately on `release()`.
_Avoid_: slot lease, concurrency token, gate ticket.

**Permit leak**:
A bug where a permit is acquired but never released, causing the gate's
`active` counter to stay elevated permanently (until process restart).
Distinct from a slow release (the cooldown delay): a leak means
`releasePermit()` was never called at all. Symptoms: `active` exceeds
the true in-flight count, and captures remain stuck in `state="streaming"`
with no terminal status. Root cause: when the upstream sends some data
then hangs (post-return), `AbortSignal.timeout(upstreamTimeoutMs)` aborts
the `upstreamSignal`, but `req.signal` does NOT abort (the client is still
connected). On Bun 1.3.14, `TransformStream.flush()` does not fire on
abnormal termination, and `TransformStream.cancel()` is not called
(contradicts WHATWG spec but empirically confirmed). Before the fix,
`onAbort` listened only on `req.signal`, so the permit leaked. Fixed by
also listening on `upstreamSignal` (Part A), fixing the already-aborted
`req.signal` branch (Part B), and adding a per-request watchdog timer
(Part C).
_Avoid_: slot leak, concurrency leak, stuck slot.

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

### Usage History

**Priority tuple**:
The composite priority state `{ priorityLow, boxedUntil, boxedReason,
unitsDemoted, demotedUntil }` derived from a `/v1/usage` snapshot. The
usage-history event detector emits exactly one `usage_events` row per
tuple change (not per field) — so "entered priority-low AND boxed AND
demoted in a single poll" is one onset event, not three. A change is
detected by structural equality of the whole tuple.
_Avoid_: priority state, priority fields, priority flags.

**Service_mode tuple**:
The composite service-mode state `{ current, resetsAt }` derived from a
`/v1/usage` snapshot. Like the priority tuple, one event per tuple change:
entering non-normal service_mode is one onset, regardless of how many
fields flipped. `current = "normal"` with `resetsAt = null` is the
all-clear state.
_Avoid_: service state, service flags, mode tuple.

**Dimension A (accumulated active hours)**:
Sum of minutes between non-byte-identical adjacent `usage_samples` rows
within the configured gap threshold — i.e. actual activity time,
excluding idle-coalesce gaps where nothing changed. Stored on the
`usage_daily` row as `accumulated_active_minutes` and bucketed by UTC hour
in `active_minutes_by_utc_hour`. Bot-detection theory: "humans work ≤8h,
bots work 24h." Distinct from Dimension B.
_Avoid_: active hours, activity minutes, working hours.

**Dimension B (UTC clock span)**:
The wall-clock span of activity within a UTC day, computed as
`last_activity_utc − first_activity_utc`. Stored on the `usage_daily` row
as `utc_clock_span_minutes` (plus `first_activity_utc_hour` and
`last_activity_utc_hour` for at-a-glance visibility). Bot-detection
theory: "umans simplistically computes span, assumes span > 8h = bot."
Distinct from Dimension A: a human working 08:00–12:00 + 23:00–01:00
has Dimension A = 7h but Dimension B = 16h (on day N, if split at UTC
midnight).
_Avoid_: clock span, activity span, wall-clock hours.

**day_completeness**:
The completeness flag on a `usage_daily` row describing how completely
the UTC day was observed by the proxy. Values: `full` (proxy ran the
whole day with no mid-day gaps above `usage_gap_threshold_minutes` between
non-byte-identical adjacent samples), `partial_start` (first sample's UTC
hour > 0 — proxy started mid-day), `partial_end` (last sample's UTC hour
< 23 — proxy stopped mid-day), `partial_both` (both), `missing` (proxy
was down all day — backfilled with NULL activity fields so the long-term
calendar shows a clear "no data" marker), `incomplete_window` (a mid-day
gap above the threshold existed between non-identical adjacent samples).
Used to filter or annotate partial days in the heatmap so they aren't
treated as valid full-day pattern data points.
_Avoid_: completeness flag, day quality, coverage.

**cacheHitRate (history variant)**:
The aggregate cache-hit metric stored on `usage_samples` and
`usage_events` rows, computed as
`tokensCached / (tokensIn + tokensOut + tokensCached)`, stored as a real
number 0–1 (null when the denominator is zero). Distinct from the
existing `cached_pct` (which uses `total_input_tokens` as the denominator
and is a per-capture metric on the Performance tab, not a `/v1/usage`-
derived metric). The history variant uses the upstream `/v1/usage` token
counters (`tokens_in`, `tokens_out`, `tokens_cached`), not per-request
capture data, so it reflects account-level cache efficiency at the
moment of the poll.
_Avoid_: cache hit rate (without qualifier), hit ratio, cache efficiency.

**Priority budget**:
An upstream account-level usage budget category (e.g. "frontier"),
returned by `/v1/usage` as an array entry with `category`, `label`,
`models[]`, `used_pct`, `over_budget_today`, `mode`, and `resets_at`.
Distinct from the proxy's internal rate-limiting gate: the upstream
enforces the budget, the proxy only surfaces it for display. Not
persisted in `usage_samples` or `usage_events`; served live on
`UsageSnapshot.priorityBudget` and summarized as
`GateStats.priorityBudgetSummary`.
_Avoid_: budget tier, spending cap, model budget.

**Most urgent budget**:
The single `priority_budget` entry selected for the compact GateStatus
badge via `selectMostUrgentBudget()` (`src/usage/budget.ts`): over-budget
entries first (highest `used_pct` among them), otherwise highest
`used_pct` overall. Hidden when the array is empty or all entries
report `used_pct = 0`. The Usage tab shows all entries regardless; only
the header badge uses the selection.
_Avoid_: top budget, worst budget, active budget.
