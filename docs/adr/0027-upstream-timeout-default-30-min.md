# Upstream timeout default raised to 30 minutes

## Status

Accepted.

## Context

The `upstream_timeout_ms` config field (absolute wall-clock timeout for a
single upstream fetch, including streaming) defaulted to 300000ms (5 min)
since the proxy's inception. This was adequate when upstream models had
modest max output and reasonable TPS.

The addition of high-output models (e.g. GLM with 131K max output tokens)
at low TPS (~30 tokens/s) makes 5 min insufficient: a legitimate
full-length response takes ~72 min to stream. A 5-min timeout kills these
requests mid-stream even though the upstream is working correctly.

The [smart TTFT watchdog](0026-smart-ttft-watchdog-dynamic-threshold.md)
design relies on `upstream_timeout_ms` as the absolute ceiling against
which the TTFT hard cap is clamped
(`min(hard_cap, upstream_timeout_ms - 1000)`). With the old 5-min default,
the clamp was tight (`min(300000, 299000)` = 299000ms), leaving almost no
headroom. Raising the default to 30 min makes the clamp non-binding at
default config (`min(300000, 1799999)` = 300000).

## Decision

Raise the `upstream_timeout_ms` default from 300000ms (5 min) to
1800000ms (30 min).

This is a general default change, not gated by `experiment_ttft_watchdog`.
It applies to all requests regardless of whether the watchdog is enabled.

## Considered options

- **Keep 5 min, let operators raise it.** Rejected. The 5-min default is
  silently hostile to high-output models — operators discover it only when
  legitimate requests fail with 504 mid-stream. The default should be safe
  for the slowest legitimate case, not optimized for the fastest.

- **Make it conditional on model.** Rejected. Model-specific timeouts
  require a model registry mapping and complicate the config surface. A
  single generous default is simpler and sufficient — the TTFT watchdog
  catches stalled connections (the actual failure mode) at the first-byte
  phase regardless of the absolute timeout.

- **Raise to 72 min (worst-case GLM output).** Rejected. 30 min is
  permissive enough for the vast majority of legitimate streams while
  keeping an upper bound on permit holding. A 72-min timeout would let a
  single stalled request hold a concurrency permit for over an hour.

## Consequences

- Legitimate long-output streams (GLM 131K at 30 TPS, Qwen at 40 TPS, etc.)
  complete without mid-stream 504s at default config.
- Stalled connections hold permits for up to 30 min when the TTFT watchdog
  is disabled (default). Operators raising `upstream_timeout_ms` above
  300000 should enable `experiment_ttft_watchdog=true` to prevent permit
  exhaustion from stalls. This caveat is documented in ADR-0026 §5.
- The TTFT watchdog's hard-cap clamp is non-binding at default config:
  `min(300000, 1800000 - 1000)` = 300000. No race between the TTFT timer
  and the upstream timeout.
- Worst-case permit hold with watchdog enabled: ~15 min (3 attempts × 5 min
  hard cap + 2 × 5s cooldown). Well under the 30-min absolute timeout.
- Existing operators with explicit `upstream_timeout_ms` in config.json are
  unaffected — the default change only applies when the field is absent.
