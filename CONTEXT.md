# umans-gate — Domain Glossary

Pure glossary of domain terms. Definitions only — no implementation
details, file paths, or code references.

## Caching

**Cache hit** — a request whose prefix (system + tools + messages, up to a
`cache_control` breakpoint) byte-for-byte matches a prior cache entry
written within the TTL. Reported as `cache_read_input_tokens > 0`.
_Avoid_: cache match, cached request.

**Cache write** — the first request that establishes a cache entry for a
given prefix. Reported as `cache_creation_input_tokens > 0`. The same
request cannot also be a cache hit (writes happen during response
generation). _Avoid_: cache creation, cache store, cache populate.

**Cache miss** — a request where no prior cache entry exists for the prefix
(cold start, TTL expired, or prefix changed). Reported as
`cache_creation_input_tokens = 0 AND cache_read_input_tokens = 0`. Distinct
from a cache write (which intentionally establishes a new entry).
_Avoid_: cache fault, uncached.

**Breakpoint** — a content block annotated with
`cache_control: { type: "ephemeral", ttl: "1h" }`. Anthropic writes one
cache entry per breakpoint, hashing the cumulative prefix from request
start through that block. Maximum 4 per request. _Avoid_: cache marker,
cache point.

**Lookback window** — the 20-block window Anthropic searches backward from
a breakpoint for a prior cache write. If no write exists within 20 blocks,
the breakpoint is a miss regardless of prefix stability. _Avoid_: search
window, cache scan range.

## Metrics

**cached_pct** — the aggregate cache metric on the Performance tab.
Computed as `SUM(cache_read_tokens) / SUM(total_input_tokens) * 100`.
Structurally cannot reach 100% because `total_input_tokens` includes fresh
`input_tokens` on every request. _Avoid_: cache ratio, hit ratio.

**Cache hit rate (per-row)** — the per-capture badge. Same ratio as
`cached_pct` but per row. Cannot reach 100% for the same structural reason.
_Avoid_: cache percentage, row hit rate.

**total_input_tokens** — `input_tokens + cache_creation_input_tokens +
cache_read_input_tokens`. The full input bill; denominator in cache
metrics. _Avoid_: prompt tokens, input total.

**input_tokens** — the uncached portion of input (new user message plus
any prefix not covered by hit/write). Always > 0 on any real request.
_Avoid_: fresh tokens, new tokens.

**total_output_tokens** — the full output bill (`output_tokens` for
Anthropic, `completion_tokens` for OpenAI). Includes thinking tokens.
_Avoid_: completion tokens, response tokens.

**thinking_tokens** — the subset of output spent on internal reasoning.
Extracted from `output_tokens_details.thinking_tokens` (Anthropic) or
`completion_tokens_details.reasoning_tokens` (OpenAI); null when not
reported. _Avoid_: reasoning tokens.

## Stamping

**Stamp policy** — the per-model tuning values applied by the stamp
pipeline: `max_tokens`, `effort` ("high" or "max"), `thinking` (whether to
inject `{ type: "adaptive" }`), and `top_k` (null or a number). Distinct
from model capabilities (upstream-reported). _Avoid_: stamp config, model
tuning.

**Stamp overlay** — the declarative table mapping model-family patterns
(e.g. `"umans-glm*"`) to stamp policies. The overlay owns proxy-specific
tuning; upstream `/v1/models/info` owns capabilities. Adding a new model
family is a single row, not a code change. _Avoid_: stamp table, model
overrides.

## Architecture

**TTFT watchdog** — a wall-clock timer started at fetch initiation; fires
if no first chunk arrives within `ttft_timeout_ms`. Distinct from the
absolute `upstream_timeout_ms` (whole-fetch ceiling) and from the semantic
`ttft_ms` metric (first delta, computed post-hoc). When it fires, the fetch
is aborted and a gated retry may follow. _Avoid_: first-byte timeout.

**TTFT retry** — a retry triggered by TTFT-watchdog timeout, distinct from
a 502/529 rewrite-id retry. Reuses the original permit and is exempt from
the rate limiter. Gated by upstream-load signals. When suppressed, the
client gets a 504. _Avoid_: stream retry, first-byte retry.

**Attempt** — a single upstream fetch within a TTFT-retry lifecycle.
Attempt 1 is the original; attempt 2 is the same-key retry; attempt 3 is
the rewrite-id escalation. Distinct from "request" (the client-initiated
operation, which may span multiple attempts under one capture row).
_Avoid_: try, fetch number.

**Retry state** — the live phase of a TTFT-retry lifecycle as seen by the
dashboard: `cooldown`, `retry N`, `retried`. Distinct from the final
`x-proxy-retry-attempt` / `x-proxy-ttft-exceeded` headers. _Avoid_: retry
status, retry phase.

**Stop gate** — the concurrency admission layer. Acquires a permit before
forwarding upstream; rejects with `GateError` codes (`circuit_open`,
`queue_full`, `timeout`, `aborted`) when the breaker is open or the queue
overflows. Gate-rejected captures are excluded from `cached_pct`. Does not
influence cache hit rate. _Avoid_: limiter, admission control.

**Permit** — the concurrency slot lease. Acquired before forwarding;
released exactly once. Has a `weight` (scaled) and an `intention` (`"main"`
or `"vision"`). Releases are batched and deferred by `release_cooldown_ms`.
_Avoid_: slot lease, concurrency token.

**Permit leak** — a bug where a permit is acquired but never released,
causing the `active` counter to stay elevated permanently. Distinct from
a slow release (the cooldown delay). _Avoid_: slot leak, stuck slot.

**Breakpoint repositioning** — a harness-side behavior where
`cache_control` breakpoints are placed on the rolling message tip. Each
turn the harness strips the breakpoint from the previously-tip blocks and
re-adds it to the new tip. Invalidates the hash from that point forward.
Not a proxy behavior. _Avoid_: cache_control stripping, tip shifting.

**Message truncation** — a harness-side behavior where historical messages
are dropped mid-session. Distinct from breakpoint repositioning: content
itself is removed, not just the annotation. Invalidates cache from the
truncation point. Not a proxy behavior. _Avoid_: context compression,
message compaction.

**Cold start** — the first request of a new conversation (or subagent
invocation with a different system prompt). Always reports
`cache_read_input_tokens = 0` because no cache entry exists yet.
Architecturally unavoidable. _Avoid_: first-turn miss, warmup miss.

**Session-scoped cache** — the upstream appears to key cache lookup by
`x-session-id` request header. When the harness assigns a new session ID
per invocation, the first request misses the cache even with identical
prompts. Not a proxy behavior. _Avoid_: session cache, per-session cache.

## Usage History

**Priority tuple** — the composite priority state `{ priorityLow,
boxedUntil, boxedReason, unitsDemoted, demotedUntil }`. One event per
tuple change (not per field). _Avoid_: priority state, priority flags.

**Service_mode tuple** — the composite service-mode state `{ current,
resetsAt }`. One event per tuple change. `current = "normal"` with
`resetsAt = null` is the all-clear. _Avoid_: service state, mode tuple.

**Dimension A (accumulated active hours)** — sum of minutes between
non-byte-identical adjacent samples within the gap threshold. Actual
activity time, excluding idle gaps. Bot-detection theory: "humans work
≤8h, bots work 24h." _Avoid_: active hours, working hours.

**Dimension B (UTC clock span)** — the wall-clock span of activity within a
UTC day (`last_activity_utc − first_activity_utc`). Bot-detection theory:
"span > 8h = bot." Distinct from Dimension A. _Avoid_: clock span,
activity span.

**day_completeness** — flag describing how completely the UTC day was
observed. Values: `full`, `partial_start`, `partial_end`, `partial_both`,
`missing`, `incomplete_window`. Used to filter partial days in the heatmap.
_Avoid_: completeness flag, day quality.

**cacheHitRate (history variant)** — the aggregate cache-hit metric stored
on usage rows, computed as `tokensCached / (tokensIn + tokensOut +
tokensCached)`, stored as 0–1. Distinct from `cached_pct` (per-capture,
uses `total_input_tokens` denominator). _Avoid_: cache hit rate (without
qualifier).

**Priority budget** — an upstream account-level usage budget category,
returned by `/v1/usage` with `category`, `label`, `models[]`, `used_pct`,
`over_budget_today`, `mode`, `resets_at`. The upstream enforces the budget;
the proxy only surfaces it. _Avoid_: budget tier, spending cap.

**Most urgent budget** — the single `priority_budget` entry selected for
the compact GateStatus badge: over-budget entries first, otherwise highest
`used_pct`. _Avoid_: top budget, worst budget.

**Admission state** — the composite degradation state derived from the
priority tuple and service_mode tuple together. Distinct from budget state
(a quota gauge). _Avoid_: gate state, degradation flags.

**Gate health** — the composite badge merging admission state and most
urgent budget into a single indicator. Label is severity-ordered
(`boxed` > `demoted` > budget-over-80% > low-mode > `high`). _Avoid_:
combined badge, unified indicator.

## Design system

**Accent Hue** — the violet (HSL 263°) used for focus rings, chart series,
and sidebar-primary. Chosen for perceptual distinctness from the neutral
base palette and traffic-light status colors. _Avoid_: brand color, theme
color.

**Functional Border** — a border delimiting an interactive element (inputs,
select triggers) that must meet WCAG 1.4.11 (3:1). Distinct from decorative
borders (exempt). _Avoid_: input border, outline.

**Chart Palette** — the five-hue sequence: violet (263°), cyan (200°),
amber (30°), rose (340°), teal (160°). Each tuned per-theme for WCAG
1.4.11. _Avoid_: chart colors, data colors.

**Badge Tint Tier** — the Tailwind shade step for light-theme semantic
badge backgrounds (`*-100` for success/warning/info, `*-200` for gold).
Equal-weight philosophy: hue carries meaning, not lightness. _Avoid_:
badge shade, status fill.

## Version & Updates

**Version check** — comparison of the running version against the latest
published npm version, with GitHub Releases as fallback. Performed at boot
and on-demand. Distinct from the CLI's `update --check`. _Avoid_: update
check, version poll.

**One-click update** — a dashboard-initiated self-update, available only
when running as a managed service with `DASHBOARD_TOKEN` set. Performs
pre-flight, then asynchronously stops/updates/starts the service.
_Avoid_: dashboard update, auto-update.

**Update availability indicator** — a minimal visual cue in the dashboard
header that appears only when `updateAvailable: true`. Zero visual cost
when up-to-date. _Avoid_: version badge, update notification.

**Release notes** — the markdown body of the GitHub Release for the latest
version, fetched only when an update is detected. Rendered as a
collapsible "What's new" section. _Avoid_: changelog snippet.

**Body render state** — the phase of a capture's lifecycle as seen by the
body renderer, derived from the capture `state`. Three cases: in-flight
(spinner), done + null body (muted message), empty string. _Avoid_: body
status, body phase.

## Configuration

**experimental** (label) — a humility claim about unmeasured user-visible
effects, not a statement about code quality. Applied to fields whose felt
benefits have not been benchmarked against a control. _Avoid_: prototype,
beta, unstable.
