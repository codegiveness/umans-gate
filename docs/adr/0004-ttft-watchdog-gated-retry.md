# TTFT-watchdog gated retry (experimental)

## Status

Proposed.

## Context

The user observes TTFT > 60s with no first byte and no error against
`https://api.code.umans.ai` — consistent with upstream deprioritization or a
stuck connection on a saturated node, not a hard 429. The existing
`upstream_timeout_ms` (5-min absolute wall-clock) is too long for the
first-byte phase: a stuck connection holds a concurrency permit for 5 minutes
before failing. The existing `ttft_ms` metric is measured and broadcast on
first chunk but is not a watchdog trigger. There is no mechanism to abort a
stuck-on-first-byte fetch early and retry.

External references: kiro-gateway's `stream_with_first_token_retry` and
LiteLLM's `stream_timeout` implement the canonical pattern — race the first
chunk against a short timeout, abort and retry if it doesn't arrive. The
upstream is not open about why TTFT degrades, so we cannot distinguish a
per-request stall (stuck node, deprioritized session — retry helps) from a
systemic degradation (upstream overloaded — retry doubles load and risks
ToS flagging).

## Decision

Add an experimental TTFT-watchdog gated-retry feature, off by default, that:

1. **Races the first chunk against `ttft_timeout_ms`.** A dedicated
   `AbortController` (separate from `req.signal` and the absolute
   `upstream_timeout_ms`) aborts the fetch if no first chunk arrives within
   the threshold. The watchdog uses the existing `firstChunkSent` perception
   (first chunk from `upstream.body`, via manual `reader.read()`) — no new
   concept of "first byte." The absolute `upstream_timeout_ms` remains armed
   throughout; the watchdog is an additional, tighter guard for the
   first-byte phase only.

2. **Gates retry on upstream-load signals.** Retry is suppressed (client gets
   504) when:
   - Breaker state is not `closed` (upstream already in distress).
   - Gate saturation is above `ttft_retry_gate_saturation_pct` of the soft
     limit (upstream likely overloaded; retry would add load).
   - Recent TTFT-retry failure rate exceeds threshold (upstream systemically
     slow).

3. **Auto-disables when ineffective.** If `ttft_retry_failure_threshold`
   consecutive TTFT-retries also time out within
   `ttft_retry_failure_window_ms`, the feature turns itself off entirely and
   logs `"experiment_ttft_watchdog auto-disabled: efficacy below threshold"`.
   No more watchdog firings or double-sends until manual re-enable. This
   makes the experiment self-falsifying — if it doesn't work against this
   upstream, it tells you instead of quietly double-sending forever.

4. **Retry ladder.** Attempt 1 (original) → TTFT timeout → attempt 2 (same
   key, same body, gated by upstream-load signals) → TTFT timeout → attempt 3
   (rewrite-id escalation, only if `experiment_rewrite_ids` is on AND
   eligible AND `ttft_retry_max_attempts >= 3`) → 504. The retry reuses the
   original permit (single-release contract preserved) and is exempt from the
   rate limiter (original token already consumed; no upstream success
   occurred).

5. **Manual first-chunk read with wrapped stream.** Before creating the
   `TransformStream` (which owns `releasePermit` via its `flush`), the
   orchestrator reads the first chunk manually via
   `upstream.body.getReader().read()`. If the watchdog fires during this
   read, `reader.cancel()` and retry without touching the permit. If the
   read rejects, check `req.signal.aborted` — if the client aborted, return
   499 (no retry); if the TTFT controller aborted, retry; if the absolute
   timeout fired, return 504 (no retry). If the read succeeds with a chunk,
   build a new `ReadableStream` that yields the first chunk in `start()`,
   pulls subsequent chunks from the reader in `pull()`, and forwards
   `cancel()` to `reader.cancel()`. This wrapped stream is then piped
   through the existing `TransformStream` — so the capture logic, TTFT
   broadcast, and `flush` → `releasePermit` path all work unchanged. The
   `releaseLock()` call is NOT used because the wrapped stream's `pull()`
   owns the reader for the stream's lifetime; `pipeThrough` works on the
   wrapped stream (not the original locked one).

6. **Extends `attemptRewriteRetry`** with optional `ttftController?` and
   `forceEscalate?` params. The existing 502/529 path passes neither (no
   behavior change). The TTFT path passes both — arming the watchdog on
   attempt 3's fetch and forcing `experiment.escalate()` unconditionally
   (bypassing the `shouldEscalate(consecutive502s)` check, which TTFT
   timeouts don't increment).

7. **Does NOT trip the circuit breaker on TTFT timeout.** Neither
   `record429` nor `recordSuccess` is called for a TTFT-aborted attempt. The
   breaker's semantics (concurrency-429s only) are unchanged.

8. **Response headers on the final response.** `X-Proxy-Retry-Attempt: <n>`
   (0 = no retry), `X-Proxy-TTFT-Exceeded: 1` (if watchdog fired),
   `X-Proxy-Breaker-State: <closed|half_open|open>`.

## Considered Options

- **Blind retry (no gating).** Rejected. Doubles load on a systemically
  degraded upstream; risks ToS flagging. The user explicitly wants to avoid
  looking like a spammer.
- **Cooldown only (no auto-disable).** Rejected. The "double job" never
  fully stops — the feature keeps firing-and-cooldowning in cycles even
  when it's clearly not helping. Auto-disable makes the experiment
  self-falsifying.
- **Replace `upstream_timeout_ms` during first-chunk phase.** Rejected. The
  absolute timeout is the hard ceiling on the whole fetch lifecycle; making
  it conditional on first-chunk phase creates a 360s worst case (60s TTFT +
  300s absolute on the rest of a stuck-after-one-chunk stream).
- **Keep `pipeThrough` with a retry flag.** Rejected. Aborting a piped
  stream triggers `flush` → `releasePermit` prematurely; the retry flag
  approach is fragile and invasive to the existing streaming path.

## Consequences

- A new config field family (`experiment_ttft_watchdog`, `ttft_timeout_ms`,
  `ttft_retry_*`) is added as hot-reloadable. None go into
  `RESTART_REQUIRED_FIELDS` or `GATE_RECONFIG_FIELDS`.
- `attemptRewriteRetry` gains two optional params; its existing callers are
  unaffected.
- The proxy's fetch/streaming structure gains a manual first-chunk read
  before `TransformStream` creation. The `TransformStream` logic itself is
  unchanged — it still owns `releasePermit` via `flush`, but only after the
  orchestrator has committed to this response.
- If the feature is ineffective against this upstream, it auto-disables and
  logs. The user re-enables manually after investigating.
- The feature is off by default. Existing tests are unaffected because the
  watchdog is not armed when `experiment_ttft_watchdog` is false.
