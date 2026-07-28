# Smart TTFT watchdog: dynamic threshold from real-time p50

## Status

Accepted. Supersedes [ADR-0004](0004-ttft-watchdog-gated-retry.md). Related:
[ADR-0027](0027-upstream-timeout-default-30-min.md) raises the
`upstream_timeout_ms` default that this design clamps against.

## Context

ADR-0004 introduced a static-threshold TTFT watchdog: a fixed `ttft_timeout_ms`
(default 60s) applied to every model, with a 3-attempt retry ladder and
permanent auto-disable after repeated failures. The static threshold does not
adapt to upstream conditions — it is either too loose for fast models (a stalled
connection on a model with p50 TTFT of 2s waits 60s before detection) or too
tight for slow models (a legitimately slow model with p50 TTFT of 8s gets killed
at 60s when 40s would suffice).

The proxy's role is a **balancer** between harness and upstream: absorb
upstream slowness via retries so the harness does not see it, but send 5xx when
the upstream is genuinely broken so the harness's own retry mechanism engages.
The static threshold cannot serve this role because it has no signal for what
"slow" means at this moment for this model.

The upstream provides a real-time status endpoint
(`https://api.code.umans.ai/v1/status`) reporting per-model p50 TTFT latency
over a 5-minute window. This makes a dynamic, per-model threshold possible
without local persistence: the proxy derives the threshold fresh on each request
from current upstream reality.

## Decision

Replace the static-threshold watchdog with a **dynamic two-tier threshold**
design.

1. **Dynamic threshold for attempt 1.** The watchdog threshold for the original
   fetch is `min(p50 × multiplier, hard_cap_ms)` where p50 is the model's
   real-time median TTFT fetched in parallel from `/v1/status`. The status
   fetch is non-blocking: the watchdog starts with `ttft_timeout_ms` (60s
   fallback) and tightens if the status response arrives before the watchdog
   fires. Model bridging resolves aliases via `base_model.name` from
   `ModelsClient`; falls back to overall p50, then to 60s.

2. **Hard cap for attempt 2+.** Retries use a flat `ttft_watchdog_hard_cap_ms`
   (default 300000ms = 5 min). Rationale: attempt 1 detects stalled connections
   fast; retries give legitimate prefill room to complete. The hard cap also
   ceilings the dynamic threshold (`min(p50 × multiplier, hard_cap_ms)`), so
   attempt 2 is never stricter than attempt 1.

3. **No persistence, no escalation ladder, no auto-disable.** The threshold is
   derived per-request from the status API. No SQLite threshold store, no
   ratchet-up/ratchet-down state machine, no `consecutiveFailures` counter.
   The watchdog is always ready — it never permanently disables. If all
   attempts exhaust, the client gets a 504 and the harness's own retry engages.

4. **Three attempts max.** Attempt 1 (dynamic threshold) → cooldown
   (`ttft_retry_cooldown_ms`, 5s) → attempt 2 (hard cap, same-key retry) →
   cooldown → attempt 3 (hard cap, rewrite-id escalation, always on
   independent of `experiment_rewrite_ids`) → 504. Default
   `ttft_retry_max_attempts` raised from 2 to 3.

5. **No upstream timeout override.** The effective hard cap is clamped against
   the existing `upstream_timeout_ms`: `min(configured_hard_cap,
   upstream_timeout_ms - 1000)`. The 1s buffer ensures the TTFT watchdog always
   fires before the absolute upstream timeout, preventing a race where the
   upstream timeout kills the fetch before the watchdog can trigger a retry.
   The `ttft_timeout_ms` fallback is clamped the same way:
   `min(ttft_timeout_ms, upstream_timeout_ms - 1000)`. The general
   `upstream_timeout_ms` default is raised from 300000ms to 1800000ms (30 min)
   to accommodate low-TPS models with high max output (e.g. GLM 131K tokens at
   30 TPS). When the watchdog is disabled, `upstream_timeout_ms` applies as-is.
   No separate override config field.

   **Caveat:** when `upstream_timeout_ms` > 300000 and
   `experiment_ttft_watchdog` is false (default), stalled connections hold
   permits for up to 30 min with no breaker protection. Operators should enable
   the watchdog when raising the upstream timeout.

6. **Parallel status fetch with dedup.** Each request fires a `/v1/status`
   fetch as a detached promise alongside the upstream request. Concurrent
   requests share a single in-flight promise (dedup). No TTL cache — the
   status endpoint is cheap, and freshness is the point. On fetch failure,
   log a warning and fall back to `ttft_timeout_ms`.

7. **Upstream p50 capture.** The model-specific p50 TTFT and p50 TPS from the
   status response are recorded on the capture row (`upstream_ttft_p50_ms`,
   `upstream_tps_p50`). The capture card shows a 4th row:
   `p50 3.8s · 116 t/s · 1.1x` where the ratio is actual TTFT / p50 TTFT.
   Progressive enhancement — only renders when p50 data is present.

8. **Badge: `retry {N} · {threshold}s` (watching) / `retry {N} · cd {s}s`
   (cooldown).** Merges the prior separate `cooldown 5s` and `retry 2` badges
   into one. Attempt 1 shows `running` (no threshold — happy path). Threshold
   appears only when the proxy is being patient (retrying).

## Config fields

| Field | Default | Status |
|-------|---------|--------|
| `experiment_ttft_watchdog` | false | Existing (repurposed) |
| `ttft_timeout_ms` | 60000 | Existing (now fallback threshold) |
| `ttft_retry_max_attempts` | 3 | Existing (default 2→3) |
| `ttft_retry_cooldown_ms` | 5000 | Existing (default 30000→5000) |
| `ttft_retry_gate_saturation_pct` | 80 | Existing (unchanged) |
| `ttft_watchdog_multiplier` | 5 | **New** |
| `ttft_watchdog_hard_cap_ms` | 300000 | **New** |

**Removed:** `ttft_retry_failure_threshold`, `ttft_retry_failure_window_ms`
(auto-disable is dead code under dynamic threshold).

Net: +2 new fields, −2 removed, 3 default changes (`ttft_retry_max_attempts`
2→3, `ttft_retry_cooldown_ms` 30000→5000, `upstream_timeout_ms`
300000→1800000). All hot-reloadable. Hot reload affects next request, not
in-flight requests.

## Validation rules

| Rule | Rationale |
|------|-----------|
| `ttft_watchdog_multiplier > 0` | If ≤0, p50×0=0, watchdog fires instantly |
| `ttft_watchdog_hard_cap_ms > 0 and < upstream_timeout_ms` | If ≥ upstream_timeout, clamp defeats purpose |
| `ttft_retry_max_attempts >= 1 (cap 3)` | |
| `ttft_retry_cooldown_ms >= 0` | |
| `ttft_timeout_ms > 0 and < upstream_timeout_ms` | Runtime clamped: `effective = min(ttft_timeout_ms, upstream_timeout_ms - 1000)` |
| `ttft_retry_gate_saturation_pct in [0, 100]` | If >100 never triggers, if ≤0 always suppresses |

## Considered options

- **Incremental escalation ladder (30s→60s→90s→… per retry).** Rejected.
  Per-retry escalation is theater: a stalled connection won't respond at any
  threshold, and a legitimate prefill needs one attempt with a high enough
  threshold — not many attempts with slowly increasing thresholds. Total time
  unbounded (50 min with 60s increment × 10 retries). Superseded by two-tier.

- **Context-window percentage scaling.** Rejected. Prefill time scales with
  absolute token count, not percentage of context window. A 50K-token request
  takes the same prefill whether the model supports 100K or 500K context.

- **Raw byte size as threshold floor.** Rejected as too complex. Requires
  image-stripping logic, hardcoded prefill-rate constant, and edge-case
  handling for stamp/vision body mutations.

- **Per-retry multiplier escalation (3x→3.5x→4x→…).** Rejected. Same theater
  problem as the incremental ladder. Burns attempts at gradually increasing
  thresholds that are all below the prefill time needed.

- **Separate `ttft_watchdog_max_threshold_ms` ceiling.** Rejected. The hard
  cap already serves as ceiling for attempt 1 and floor for attempt 2. A
  separate field only helps if the operator wants attempt 1 more generous than
  retry — an anti-pattern that loosens first, tightens on retry.

- **Background status poller.** Rejected in favor of parallel per-request
  fetch. A poller introduces staleness and a TTL cache; the per-request fetch
  with dedup is always fresh and simple.

## Consequences

- **ADR-0004 is superseded.** The static threshold, 3-attempt ladder,
  auto-disable, and `ttft_retry_failure_*` config fields are removed.
  `TtftWatchdogState` class is replaced by a `StatusClient` that fetches
  `/v1/status` with shared-promise dedup.
- **Two new nullable columns** on the `captures` table:
  `upstream_ttft_p50_ms` (integer), `upstream_tps_p50` (real).
- **`CaptureSummary` / `CaptureRow` / `ResponseMeta`** gain the two p50 fields,
  propagated through `newSummary`, `buildSummary`, `summary`, and the write
  queue.
- **Capture card gains a 4th row** (progressive enhancement, renders only when
  `upstream_ttft_p50_ms` is non-null).
- **`attemptRewriteRetry`** is called unconditionally for attempt 3 (no longer
  gated by `experiment_rewrite_ids`). The `experiment_rewrite_ids` toggle now
  only controls the reactive 502/529 rewrite path; the watchdog co-opts the
  rewrite machinery for attempt 3 regardless of that toggle.
- **`ttft_retry_max_attempts` validation cap** stays at 3. Three attempts is
  sufficient: dynamic catches stalls, hard cap gives prefill room, rewrite is
  last resort.
- **Worst-case total time** bounded at `3 × effective_hard_cap + 2 × cooldown` =
  910s (15.2 min). Each individual attempt is bounded by
  `min(hard_cap, upstream_timeout_ms - 1000)`. With the new
  `upstream_timeout_ms` default of 1800000ms (30 min), the clamp is
  non-binding at default config (`min(300000, 1799999)` = 300000).
- **No permanent disable.** The watchdog is always ready. If the upstream is
  genuinely broken, all 3 attempts exhaust and the harness gets a 504.
