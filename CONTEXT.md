# umans-gate domain glossary

> **Applies to:** umans-gate v0.4.8 · **Last updated:** 2026-07-28

Pure glossary of domain terms. Definitions only: no implementation
details, file paths, or code references.

## Caching

**Cache hit**: a request whose prefix (system + tools + messages, up to a
`cache_control` breakpoint) byte-for-byte matches a prior cache entry
written within the TTL. Reported as `cache_read_input_tokens > 0`.
_Avoid_: cache match, cached request.

**Cache write**: the first request that establishes a cache entry for a
given prefix. Reported as `cache_creation_input_tokens > 0`. The same
request cannot also be a cache hit (writes happen during response
generation). _Avoid_: cache creation, cache store, cache populate.

**Cache miss**: a request where no prior cache entry exists for the prefix
(cold start, TTL expired, or prefix changed). Reported as
`cache_creation_input_tokens = 0 AND cache_read_input_tokens = 0`. Distinct
from a cache write (which intentionally establishes a new entry).
_Avoid_: cache fault, uncached.

**Breakpoint**: a content block annotated with
`cache_control: { type: "ephemeral", ttl: "1h" }`. Anthropic writes one
cache entry per breakpoint, hashing the cumulative prefix from request
start through that block. Maximum 4 per request. _Avoid_: cache marker,
cache point.

**Lookback window**: the 20-block window Anthropic searches backward from
a breakpoint for a prior cache write. If no write exists within 20 blocks,
the breakpoint is a miss regardless of prefix stability. _Avoid_: search
window, cache scan range.

## Metrics

**cached_pct**: the aggregate cache metric on the Performance tab.
Computed as `SUM(cache_read_tokens) / SUM(total_input_tokens) * 100`.
Structurally cannot reach 100% because `total_input_tokens` includes fresh
`input_tokens` on every request. _Avoid_: cache ratio, hit ratio.

**Cache hit rate (per-row)**: the per-capture badge. Same ratio as
`cached_pct` but per row. Cannot reach 100% for the same structural reason.
_Avoid_: cache percentage, row hit rate.

**total_input_tokens**: `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens`. The full input bill; denominator in cache
metrics. _Avoid_: prompt tokens, input total.

**input_tokens**: the uncached portion of input (new user message plus
any prefix not covered by hit/write). Always > 0 on any real request.
_Avoid_: fresh tokens, new tokens.

**total_output_tokens**: the full output bill (`output_tokens` for
Anthropic, `completion_tokens` for OpenAI). Includes thinking tokens.
_Avoid_: completion tokens, response tokens.

**thinking_tokens**: the subset of output spent on internal reasoning.
Extract from `output_tokens_details.thinking_tokens` (Anthropic route) or
`completion_tokens_details.reasoning_tokens` (OpenAI route); null when the
upstream gateway does not report it. On the Anthropic route via
`api.code.umans.ai`, this field is null for non-Claude models (GLM, Kimi,
Qwen) because the gateway does not populate `output_tokens_details`. The
OpenAI route may populate `reasoning_tokens` depending on the model.
_Avoid_: reasoning tokens.

**thinking_block_count**: structural count of thinking/reasoning content
blocks observed in the response. On the OpenAI route, set to 1 when
`reasoning_content` is present, else 0. On the Anthropic route, always null
(ADR-0024): the upstream gateway does not report `thinking_tokens` for
non-Claude models, so counting blocks produces dashboard noise ("N req w/
think (unmeasured)") without actionable signal. The dashboard gates the
"unmeasured" fallback on `provider === "openai"`, so Anthropic rows never
render it, even stale rows from before the change. The `thinking_tokens`
extraction pipeline is preserved on the Anthropic route for forward
compatibility if the gateway ever starts reporting it. _Avoid_: thinking
block tally, reasoning block count.

## Stamping

**Stamp policy**: the per-model tuning values applied by the stamp
pipeline: `max_tokens`, `effort` ("high" or "max"), `thinking` (whether to
inject `{ type: "adaptive" }`), and `top_k` (null or a number). Distinct
from model capabilities (upstream-reported). _Avoid_: stamp config, model
tuning.

**Stamp overlay**: the declarative table mapping model-family patterns
(e.g. `"umans-glm*"`) to stamp policies. The overlay owns proxy-specific
tuning; upstream `/v1/models/info` owns capabilities. Adding a new model
family is a single row, not a code change. _Avoid_: stamp table, model
overrides.

**Preserved Thinking**: a capability where the model retains reasoning
content across turns. GLM exposes it via `clear_thinking: false` (Z.ai,
coding-scenario, default off on standard API). Kimi exposes it via
`keep: "all"` on the `thinking` block (Moonshot). Same concept, different
field. The proxy stamps the family-specific shape when the matching child
toggle is ON and the model version matches. _Avoid_: reasoning retention,
thinking continuity.

**Code-focused thinking model**: Kimi K2.7-Code. Always-thinking,
fixed thinking shape (`{"type":"enabled","keep":"all"}`), code-optimized.
Cannot disable thinking. Does not support `reasoning_effort` (K3-only).
_Avoid_: code model, coder thinking.

## Architecture

> ⚠️ Experimental: enabled by `experiment_ttft_watchdog` (default: off)

**TTFT watchdog**: a wall-clock timer started at fetch initiation; fires
if no first chunk arrives within `ttft_timeout_ms`. Distinct from the
absolute `upstream_timeout_ms` (whole-fetch ceiling) and from the semantic
`ttft_ms` metric (first delta, computed post-hoc). When it fires, the fetch
is aborted and a gated retry may follow. _Avoid_: first-byte timeout.

**TTFT retry**: a retry triggered by TTFT-watchdog timeout, distinct from
a 502/529 rewrite-id retry. Reuses the original permit and is exempt from
the rate limiter. Gated by upstream-load signals. When suppressed, the
client gets a 504. _Avoid_: stream retry, first-byte retry.

**Attempt**: a single upstream fetch within a TTFT-retry lifecycle.
Attempt 1 is the original; attempt 2 is the same-key retry; attempt 3 is
the rewrite-id escalation. Distinct from "request" (the client-initiated
operation, which may span multiple attempts under one capture row).
_Avoid_: try, fetch number.

**Retry state**: the live phase of a TTFT-retry lifecycle as seen by the
dashboard: `cooldown`, `retry N`, `retried`. Distinct from the final
`x-proxy-retry-attempt` / `x-proxy-ttft-exceeded` headers. _Avoid_: retry
status, retry phase.

**Stop gate**: the concurrency admission layer. Acquires a permit before
forwarding upstream; rejects with `GateError` codes (`circuit_open`,
`queue_full`, `timeout`, `aborted`) when the breaker is open or the queue
overflows. Gate-rejected captures are excluded from `cached_pct`. Does not
influence cache hit rate. _Avoid_: limiter, admission control.

**Permit**: the concurrency slot lease. Acquired before forwarding;
released exactly once. Has a `weight` (scaled) and an `intention` (`"main"`
or `"vision"`). Releases are batched and deferred by `release_cooldown_ms`.
_Avoid_: slot lease, concurrency token.

**Permit leak**: a bug where a permit is acquired but never released,
causing the `active` counter to stay elevated permanently. Distinct from
a slow release (the cooldown delay). _Avoid_: slot leak, stuck slot.

**Breakpoint repositioning**: a harness-side behavior where
`cache_control` breakpoints are placed on the rolling message tip. Each
turn the harness strips the breakpoint from the previously-tip blocks and
re-adds it to the new tip. Invalidates the hash from that point forward.
Not a proxy behavior. _Avoid_: cache_control stripping, tip shifting.

**Message truncation**: a harness-side behavior where historical messages
are dropped mid-session. Distinct from breakpoint repositioning: content
itself is removed, not just the annotation. Invalidates cache from the
truncation point. Not a proxy behavior. _Avoid_: context compression,
message compaction.

**Cold start**: the first request of a new conversation (or subagent
invocation with a different system prompt). Always reports
`cache_read_input_tokens = 0` because no cache entry exists yet.
Architecturally unavoidable. _Avoid_: first-turn miss, warmup miss.

**Session-scoped cache**: the upstream appears to key cache lookup by
`x-session-id` request header. When the harness assigns a new session ID
per invocation, the first request misses the cache even with identical
prompts. Not a proxy behavior. _Avoid_: session cache, per-session cache.

## Usage history

**Priority tuple**: the composite priority state `{ priorityLow,
boxedUntil, boxedReason, unitsDemoted, demotedUntil }`. One event per
tuple change (not per field). _Avoid_: priority state, priority flags.

**Service_mode tuple**: the composite service-mode state `{ current,
resetsAt }`. One event per tuple change. `current = "normal"` with
`resetsAt = null` is the all-clear. _Avoid_: service state, mode tuple.

**Dimension A (accumulated active hours)**: sum of minutes between
non-byte-identical adjacent samples within the gap threshold. Actual
activity time, excluding idle gaps. Bot-detection theory: "humans work
≤8h, bots work 24h." _Avoid_: active hours, working hours.

**Dimension B (UTC clock span)**: the wall-clock span of activity within a
UTC day (`last_activity_utc − first_activity_utc`). Bot-detection theory:
"span > 8h = bot." Distinct from Dimension A. _Avoid_: clock span,
activity span.

**day_completeness**: flag describing how completely the UTC day was
observed. Values: `full`, `partial_start`, `partial_end`, `partial_both`,
`missing`, `incomplete_window`. Used to filter partial days in the heatmap.
_Avoid_: completeness flag, day quality.

**cacheHitRate (history variant)**: the aggregate cache-hit metric stored
on usage rows, computed as `tokensCached / (tokensIn + tokensOut +
tokensCached)`, stored as 0 to 1. Distinct from `cached_pct` (per-capture,
uses `total_input_tokens` denominator). _Avoid_: cache hit rate (without
qualifier).

**Priority budget**: an upstream account-level usage budget category,
returned by `/v1/usage` with `category`, `label`, `models[]`, `used_pct`,
`over_budget_today`, `mode`, `resets_at`. The upstream enforces the budget;
the proxy only surfaces it. _Avoid_: budget tier, spending cap.

**Most urgent budget**: the single `priority_budget` entry selected for
the compact GateStatus badge. Over-budget entries first, otherwise highest
`used_pct`. _Avoid_: top budget, worst budget.

**Admission state**: the composite degradation state derived from the
priority tuple and service_mode tuple together. Distinct from budget state
(a quota gauge). _Avoid_: gate state, degradation flags.

**Gate health**: the composite badge merging admission state and most
urgent budget into a single indicator. Label is severity-ordered
(`boxed` > `demoted` > budget-over-80% > low-mode > `high`). _Avoid_:
combined badge, unified indicator.

## Design system

**Accent Hue**: the violet (HSL 263°) used for focus rings, chart series,
and sidebar-primary. Chosen for perceptual distinctness from the neutral
base palette and traffic-light status colors. _Avoid_: brand color, theme
color.

**Functional Border**: a border delimiting an interactive element (inputs,
select triggers) that must meet WCAG 1.4.11 (3:1). Distinct from decorative
borders (exempt). _Avoid_: input border, outline.

**Chart Palette**: the five-hue sequence: violet (263°), cyan (200°),
amber (30°), rose (340°), teal (160°). Each tuned per-theme for WCAG
1.4.11. _Avoid_: chart colors, data colors.

**Badge Tint Tier**: the Tailwind shade step for light-theme semantic
badge backgrounds (`*-100` for success/warning/info, `*-200` for gold).
Equal-weight philosophy: hue carries meaning, not lightness. _Avoid_:
badge shade, status fill.

## Version & updates

**Version check**: comparison of the running version against the latest
published npm version, with GitHub Releases as fallback. Performed at boot
and on-demand. Distinct from the CLI's `update --check`. _Avoid_: update
check, version poll.

**One-click update**: a dashboard-initiated self-update, available only
when running as a managed service with `DASHBOARD_TOKEN` set. Performs
pre-flight, then asynchronously stops/updates/starts the service.
_Avoid_: dashboard update, auto-update.

**Update availability indicator**: a minimal visual cue in the dashboard
header that appears only when `updateAvailable: true`. Zero visual cost
when up-to-date. _Avoid_: version badge, update notification.

**Release notes**: the markdown body of the GitHub Release for the latest
version, fetched only when an update is detected. Rendered as a
collapsible "What's new" section. _Avoid_: changelog snippet.

**Body render state**: the phase of a capture's lifecycle as seen by the
body renderer, derived from the capture `state`. Three cases: in-flight
(spinner), done + null body (muted message), empty string. _Avoid_: body
status, body phase.

## External references

**umans-open-stack playbooks**: curated patterns documented in the
external [umans-open-stack](https://github.com/umans-ai/umans-open-stack)
repository (concurrency, caching, vision-handoff, workflows). umans-gate
aligns with these patterns but does not implement them. It provides
building blocks that map to the playbooks. _Avoid_: playbooks, open-stack
patterns.

## Project stance

**Personal-use project**: a project stance where the maintainer builds for
personal need, publishes source for transparency, and offers no SLA, no
backward-compatibility commitment, and no production support tier. Source is
MIT-licensed; PRs reviewed on a best-effort basis. Security vulnerabilities
are the one exception (48-hour acknowledgment SLA). _Avoid_: open-source
product, community project, supported project.

## Configuration

**experimental** (label): a humility claim about unmeasured user-visible
effects, not a statement about code quality. Applied to fields whose felt
benefits have not been benchmarked against a control. _Avoid_: prototype,
beta, unstable.

## Incidents

**Incident**: a captured request whose final `response_status` is not
200, attributed to exactly one responsible party. Stored in the
`incidents` table with one row per `capture_id` (UNIQUE). Distinct from
the capture itself (which records the full request/response). An
incident is the attribution overlay that answers "who or what caused
this non-200?" _Avoid_: failure record, error log entry.

**Responsible party**: the single attribution target for a non-200
incident. Three values: `upstream` (the LLM endpoint returned a real
non-200), `proxy` (the gate synthesized the status: rate-limit,
breaker, queue, TTFT timeout), `client` (the client disconnected,
yielding 499). Mutually exclusive: a capture is attributed to exactly
one party. _Avoid_: blame target, fault source.

**Upstream status**: the HTTP status the upstream endpoint returned,
when one was received. Null when no upstream response arrived (TTFT
timeout before first byte, client abort before fetch, gate rejection
before fetch). Distinct from `served_status` (what the client actually
saw). Equals the final `upstream.status` at `doneRes()` time.
_Avoid_: origin status, real status.

**Served status**: the HTTP status the proxy returned to the client.
Equals `upstream_status` for pass-through non-200s; synthesized by the
proxy for gate-injected statuses (429, 503, 504, 499). _Avoid_:
response status (ambiguous with `captures.response_status`).

**Incident type**: the categorical cause within a responsible party.
Six values: `upstream_error`, `ttft_timeout`, `id_rewrite`,
`rate_limited`, `gate_rejected`, `client_aborted`. Anchored at first
insert; does not change if the capture transitions. The `reason` column
carries the human-readable detail (e.g. suppression cause for
`ttft_timeout`). _Avoid_: error type, failure class.

**TTFT suppression reason**: the sub-cause appended to a `ttft_timeout`
incident's `reason` when retry was suppressed. Four values:
`breaker_open` (upstream failing; breaker tripped on 429s),
`gate_saturated` (proxy overloaded; active permits at saturation
threshold), `auto_disabled` (TTFT watchdog disabled itself after
repeated retry failures), `cap_reached` (per-request retry budget
exhausted, or rewrite escalation not eligible). Distinct from
`incident_type` (which is always `ttft_timeout`); this is the
audit-level detail of why the proxy declined to retry.
_Avoid_: retry reason, suppress cause.

## Model catalog

**Model catalog**: the merged view of upstream `/v1/models` (list with
pricing + context length) and `/v1/models/info` (rich capabilities per
model). The proxy's `ModelsClient` fetches both, derives concurrency
weights, and serves synchronous lookups. The dashboard Models tab
renders this catalog. Distinct from the stamp overlay (which is
proxy-local tuning, not upstream-reported). _Avoid_: model list, model
registry.

**Model refresh**: force-fetching the model catalog from upstream,
distinct from re-reading the cached snapshot. The dashboard Refresh
button triggers a server-side upstream re-fetch (POST), not just a
client-side re-poll (GET). Distinct from model polling (the periodic
background fetch on `models_refresh_ms` interval). _Avoid_: model
reload, model update.

## Dashboard navigation

**Config sub-tab**: a secondary tab strip rendered inside the Config
top-level tab, one pane per `GroupDef` (General, Experimental,
Advanced). Distinct from the top-level tab strip in the app header
(Captures, Vision, …, Config). Replaces the prior flat single-scroll
rendering of all config groups. _Avoid_: config tab (ambiguous with the
top-level tab), config section (that's a `SectionDef`).

**Incidents sub-tab**: a secondary tab strip rendered inside the
Incidents top-level tab, one pane per responsible party (All, Upstream,
Proxy, Client). Defaults to Upstream. Server-side filtered via the
`?responsible_party=` query param. Distinct from the top-level tab
strip. _Avoid_: incident filter, incident view.

**First-run gate**: the modal shown when `config.has_api_key` is false
(`ApiKeyGate` component). Collects the Umans API key before any other
interaction. Distinct from `TokenGate` (dashboard auth). Also the surface
for promoting experimental features on fresh install. _Avoid_: API key
modal, onboarding dialog.
