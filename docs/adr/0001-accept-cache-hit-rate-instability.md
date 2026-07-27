# Accept cache hit rate instability as harness-side behavior

## Status

Accepted

## Context

umans-gate does not attempt to force the dashboard cache hit rate to 100%. The per-row badge (`fmtCachePct(cache_read_tokens, total_input_tokens)` in `dashboard/src/components/capture-row-item.tsx`) and the aggregate `cached_pct` on the Performance tab stay below 100% in real traffic for three harness-side causes, all confirmed outside the proxy from a 197-capture sample of `umans-glm-5.2` requests:

1. **Cold starts** — the first request of any new conversation or subagent
   invocation has `cache_read_input_tokens = 0` because no cache entry
   exists yet. The cache write happens during response generation, so the
   seeding request cannot read it. Architecturally unavoidable per
   Anthropic's prompt-caching specification.

2. **Harness context compaction** — opencode mutates historical assistant
   messages in-flight (appending compaction directives like "Evaluate the
   conversation for compressible ranges..."). This changes the byte content
   of a message that sits before the cache_control breakpoint, which
   invalidates the cumulative prefix hash from that point forward. The
   20-block lookback finds no earlier write (writes only happen at
   breakpoints, which ride the conversation tip), so the message portion of
   the cache misses while the system portion still hits — producing partial
   drops of 5K–17K tokens observed in 4 mid-conversation rows.

3. **Fresh input tokens** — `total_input_tokens = input_tokens +
   cache_creation_input_tokens + cache_read_input_tokens`, and
   `input_tokens` (the new user message) is always > 0. Any formula using
   `total_input_tokens` as the denominator is structurally bounded below
   100%.

## Decision

The proxy will not counteract these effects. The caching pipeline is correct: TTL stamping applies `ttl:"1h"` to every `cache_control: {type:"ephemeral"}` block, usage extraction returns exactly what the upstream API reports, and the stop gate is excluded from cache computation by the `usage_missing = 0` filter.

## Considered Options

- **Stabilize historical messages** — rejected. The proxy cannot lie to
  the upstream API about request body contents; forwarding the harness's
  mutated body is the only semantically correct behavior.
- **Add an earlier `cache_control` breakpoint** to preserve more of the
  stable prefix when the tip invalidates — rejected. Breakpoints must sit on
  stable positions, but the proxy cannot predict which messages the harness
  will mutate. Also, opencode already places 3 of Anthropic's 4 allowed
  breakpoints; adding a 4th risks exceeding the limit and consumes the
  final slot.
- **Change the cache hit rate formula** to `cr / (cr + cc)` (excluding
  fresh `input_tokens`) — rejected. This would display 100% on steady-state
  rows but hides the real cost of fresh user content, and it changes the
  semantics of a metric that other dashboards and benchmarks depend on.

## Consequences

- The per-row badge and `cached_pct` will continue to show values below
  100% on cold starts, compaction-affected turns, and any row with
  non-trivial fresh input. This is expected, not a regression.
- Future investigators of "why isn't cache hit rate 100%?" should read
  `CONTEXT.md` and this ADR before proposing proxy-side fixes.
- If the harness (opencode) ever changes its compaction strategy to avoid
  mutating historical messages, the mid-conversation drops will disappear
  without proxy changes. That is the only realistic path to higher
  stability.
