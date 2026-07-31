# Benchmarks

> **Applies to:** umans-gate v0.6.1 · **Last updated:** 2026-07-31

Benchmark results for umans-gate proxy optimizations, measured against
`https://api.code.umans.ai/v1`.

## Methodology

- Benchmarked against `https://api.code.umans.ai/v1`.
- 5 runs per test configuration.
- Median values reported to filter outliers.
- Tests run on 2026-07-05.

## Results

| Optimization | Status | Evidence |
|---|---|---|
| HTTP/1.1 default upstream | ✅ Kept | HTTP/1.1 median 760.1ms vs HTTP/2 760.8ms, 0.7ms diff (noise) |
| HTTP/2 upstream option | ✅ Available (opt-in) | Configurable via `upstream_protocol: http2`; no measurable win at current concurrency |
| `accept-encoding: identity` | ✅ Kept | identity 852.3ms vs gzip 851.9ms on SSE, statistically tied; identity is correct for capture safety |
| Hop-by-hop stripping | ✅ Kept | RFC 7230 compliance |
| TTL stamping (1h) | ✅ Kept | Improves multi-turn KV cache hit rates (part of stamp bundle) |
| `top_k` injection (20) | ✅ Kept | Required by glm-5.2 (part of stamp bundle) |
| Vision handoff | ✅ Kept | Enables text-only models to process images; improves cacheability |
| Vision concurrency gate (concurrency=1) | ✅ Kept | Prevents racing for upstream vision slot |
| Keep-alive connection reuse | ✅ Already works (Bun internal) | warm 713.4ms vs cold 1192.3ms, 478.9ms (40%) saved via connection reuse |
| SSE gzip disable | ✅ Already on (identity) | No measurable difference; identity is safer for capture |
| Streaming TTFB | ✅ Stream is faster TTFB | stream 663.5ms vs non-stream 763.2ms, 99.7ms faster first byte |
| API path | ℹ️ Anthropic faster | Anthropic 635.0ms vs OpenAI 714.0ms, 79ms diff (model routing overhead) |

## Key findings

### Why HTTP/1.1 is the default upstream protocol

HTTP/1.1 is the default upstream protocol. Benchmarks show no measurable
difference between HTTP/1.1 and HTTP/2 for the typical 4-concurrent-SSE
workload against `api.code.umans.ai` (uvicorn upstream). HTTP/2 multiplexing
overhead exceeds its benefit at this concurrency level.

### How connection reuse affects latency

Keep-alive connection reuse saves ~479ms (40%) per request. The connection
warmer (`warmer_enabled: true`, interval 20000ms) pings `/v1/models`
periodically to keep TLS warm. The warmer skips pings when real traffic
occurred in the last interval.

### Streaming vs non-streaming first-byte latency

Streaming responses (SSE) deliver the first byte 99.7ms faster than
non-streaming responses. SSE sends the first token as soon as it is generated;
non-streaming waits for the full response.

### Compression impact on SSE responses

Forcing `accept-encoding: identity` (no compression) has no measurable
performance impact on SSE responses. Identity is kept for capture safety: the
proxy reads response bodies for capture, and decompression would add complexity
and risk corrupting streams.

## How to run the benchmarks

Benchmark scripts live in `benchmark/`. Run them to generate fresh results for
regression tracking.

```bash
# Requires a running proxy and UMANS_API_KEY
cd benchmark
bun run <benchmark-script>.ts
```

## Stamp proxy performance benchmark

> **Source:** `benchmark/stamp-proxy-perf/results/benchmark-2026-07-31T03-28-47-720451+00-00-agg.csv`
> **Run date:** 2026-07-31 · **Harness:** `benchmark/stamp-proxy-perf/harness.py`
> · 3 models × 2 provider paths × 10 turns × 2 passes = 100 requests

Measures the full umans-gate stamp bundle effect on KV-cache hit rates.
Two passes over the same matrix:

- **Pass A (vanilla, experiments OFF):** `stamp_claude_code_enabled=false`,
  `stamp_reasoning_effort_enabled=false`, `stamp_model_rules=[]`, all
  `experiment_*` flags `false`. Zero body mutation.
- **Pass B (production, experiments ON):** full stamp bundle + per-model
  thinking shapes + `reasoning_effort` stamping + experiment flags
  (`experiment_rewrite_ids`, `experiment_strip_omo_reminder`,
  `experiment_ttft_watchdog`). Whatever the user had ON before the run.

`umans-flash/anthropic` excluded — Qwen's Anthropic adapter performs prefix
caching but does not report `cache_read_input_tokens`, making hit-rate
measurement impossible on that route.

### Conclusion summary

One row per model — best route + experiments setting, with the winning
metrics from that cell.

| Model | Best route | Experiments | Hit % | Mean TTFT (ms) | Mean TPS |
|---|---|---|---|---|---|
| umans-coder | openai | OFF | 99.53 | 1942 | 72.54 |
| umans-flash | openai | ON | 89.82 | 1265 | 157.19 |
| umans-glm-5.2 | anthropic | OFF | 98.37 | 4427 | 56.98 |

**Takeaway:** only `umans-flash` benefits from the stamp bundle (ON).
`umans-coder` and `umans-glm-5.2` perform best with experiments OFF —
their upstream auto-cache is already strong and stamping destabilizes the
prefix.

### Per-cell results

| Model | Route | Pass | Hit % | Mean TTFT (ms) | Mean TPS | Valid turns |
|---|---|---|---|---|---|---|
| umans-coder | anthropic | A | 97.91 | 1699.2 | 57.72 | 10/10 |
| umans-coder | anthropic | B | 81.85 | 2083.5 | 39.29 | 10/10 |
| umans-coder | openai | A | 99.53 | 1942.1 | 72.54 | 10/10 |
| umans-coder | openai | B | 88.67 | 1904.7 | 61.89 | 10/10 |
| umans-flash | openai | A | 49.36 | 3325.4 | 63.90 | 10/10 |
| umans-flash | openai | B | 89.82 | 1265.4 | 157.19 | 10/10 |
| umans-glm-5.2 | anthropic | A | 98.37 | 4427.3 | 56.98 | 10/10 |
| umans-glm-5.2 | anthropic | B | 87.76 | 4226.1 | 39.02 | 10/10 |
| umans-glm-5.2 | openai | A | 91.35 | 16083.9 | 35.08 | 10/10 |
| umans-glm-5.2 | openai | B | 77.03 | 38796.2 | 31.63 | 4/10 |

### Recommendation: experiments ON or OFF per model + route

| Model | Route | Best config | Reason |
|---|---|---|---|
| umans-coder | anthropic | **OFF** | A wins all 3 metrics: +16.06 pp hit rate, −384 ms TTFT, +18.4 TPS |
| umans-coder | openai | **OFF** | A wins hit rate (+10.86 pp) and TPS (+10.65); B saves 37 ms TTFT (noise) |
| umans-flash | openai | **ON** | B wins decisively: +40.46 pp hit rate, −2060 ms TTFT, +93.3 TPS |
| umans-glm-5.2 | anthropic | **OFF** | A wins hit rate (+10.61 pp) and TPS (+17.96); B saves 201 ms TTFT (noise) |
| umans-glm-5.2 | openai | **OFF** | A wins all metrics; B only completed 4/10 turns (unstable) |

### Key findings

**umans-flash is the only model that benefits from the full stamp bundle.**
On the OpenAI route, experiments ON lifts hit rate from 49.36 % → 89.82 %
(+40.46 pp), cuts TTFT by 62 % (3325 → 1265 ms), and more than doubles TPS
(63.9 → 157.2). The stamp bundle's TTL + thinking-shape stabilization
appears essential for Qwen-family prefix caching on the OpenAI path.

**umans-coder (kimi) regresses with stamping on both routes.** Hit rate
drops 10–16 pp and TPS falls 10–18 tokens/s. Kimi's upstream auto-cache
is already strong without the stamp bundle; the added body mutation
(`output_config`, `context_management`, thinking shapes) destabilizes the
prefix. Keep experiments OFF for umans-coder.

**umans-glm-5.2 regresses with stamping on both routes.** Hit rate drops
10–14 pp and TPS falls 16–18 tokens/s. On the OpenAI route, pass B was
unstable — only 4 of 10 turns completed validly (mean TTFT 38.8 s, max
109 s). The stamp bundle's `reasoning_effort` injection + ID rewriting
appears to conflict with glm-5.2's OpenAI adapter. Keep experiments OFF
for umans-glm-5.2.

**TTFT improvements in pass B are noise where hit rate regressed.**
umans-coder/openai (−37 ms) and umans-glm-5.2/anthropic (−201 ms) show
marginal TTFT gains in pass B, but both lose on hit rate and TPS — the
dominant signal. Don't trade cache hit rate for sub-200 ms TTFT deltas.

### How to reproduce

```bash
# Prerequisites: running proxy, pi CLI v0.83.0+, UMANS_API_KEY set
python3 -u benchmark/stamp-proxy-perf/harness.py           # full (~25-40 min)
python3 -u benchmark/stamp-proxy-perf/harness.py --pass a  # single pass
python3 -u benchmark/stamp-proxy-perf/harness.py --dry-run # no calls
```

The harness saves and restores your production config automatically.
See `benchmark/stamp-proxy-perf/README.md` for the full methodology,
prompt design, and config-reload safety protocol.

## Historical results

Benchmark results are summarized in the tables above. Raw result files are
in `benchmark/proxy-optimizations/results/` (proxy optimizations) and
`benchmark/stamp-proxy-perf/results/` (stamp bundle effect). Run the
benchmark scripts to regenerate for regression tracking.
