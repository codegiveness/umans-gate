# Stamp Proxy Performance Benchmark

> **Location:** `benchmark/stamp-proxy-perf/` (full) and
> `benchmark/stamp-proxy-perf-smoke/` (smoke test)
> **Harness:** `harness.py` — Python 3, [pi CLI](https://github.com/anthropics/pi)
> subprocess (v0.83.0+) with `--thinking max` (forces maximum reasoning
> effort on every turn)
> **Collector:** SQLite (`~/umans-gate.db`, proxy's own capture ring buffer)
> **Data:** numeric metric columns only — **no decompression needed**

## Purpose

Measure how the full umans-gate stamp bundle affects LLM KV-cache hit rates
across 3 models × 2 provider paths × 10 conversation turns, with all
stamping/experiment features OFF (vanilla baseline) vs ON (full production
config).

Two passes, same matrix:

| Pass | Description | `stamp_claude_code_enabled` | `stamp_reasoning_effort_enabled` | `stamp_model_rules` | `experiment_*` |
|------|-------------|-----------------------------|----------------------------------|---------------------|----------------|
| **A** (baseline) | Vanilla proxy — zero body mutation | `false` | `false` | `[]` | all `false` |
| **B** (production) | Full production config — everything the user had ON | `true` | `true` | saved original (user's per-model rules) | saved original |

> **Pass B is built dynamically** from the user's pre-benchmark config. The
> harness saves `stamp_model_rules`, `experiment_*` flags, and all stamp
> toggles before the run, builds pass B from the saved values, and restores
> them after — even on error or Ctrl-C.

### Why all features OFF in pass A

`stamp_model_rules` (ADR-0020 `PerModelRuleStep`, `src/stamp-pipeline.ts:187`)
is **independent of `stamp_claude_code_enabled`** — it fires whenever a
matching rule exists, regardless of the master toggle. It mutates `thinking`
shapes on both Anthropic and OpenAI paths, changing the request body. Without
setting `stamp_model_rules: []` in pass A, the "baseline" is dirty — request
bodies are already modified by per-model rules before TTL stamping is even
considered.

Same for experiment flags (`experiment_rewrite_ids`,
`experiment_strip_omo_reminder`, `experiment_ttft_watchdog`) — they run
independently and mutate request bodies or retry behavior. All must be `false`
in pass A for a true vanilla baseline.

Pass A vs B measures the **full production stamping effect** — TTL stamping
+ per-model thinking shapes + reasoning effort + experiments. The delta in
`cache_read_tokens` between the two passes is the signal.

## Matrix

**5 cells × 10 turns × 2 passes = 100 requests**

> umans-flash/anthropic excluded — Qwen's Anthropic-compatible adapter
> performs prefix caching but doesn't report `cache_read_input_tokens`
> (confirmed by [Qwen's own client code](https://github.com/QwenLM/qwen-code/blob/4dab39c8d7442c2c67404d54296de89ab597a12b/packages/core/src/core/anthropicContentGenerator/usage.ts#L28-L54)).
> Cache IS working (input_tokens drops from 12K to 300) but the usage
> field stays 0, making hit-rate measurement impossible on this route.
> umans-flash/openai is included — OpenAI path reports `cached_tokens`
> correctly.

### Models (deduplicated)

| Model | Family | Note |
|-------|--------|------|
| `umans-coder` | kimi | same as kimi-k2.7 |
| `umans-flash` | qwen | same as qwen3.6-35b-a3b |
| `umans-glm-5.2` | glm | |

> kimi-k3 excluded (no access). kimi-k2.7 = umans-coder, qwen =
> umans-flash — deduplicated to avoid testing the same model twice.

### Provider paths

pi CLI routes to umans-gate via `~/.pi/agent/models.json` provider config.
Two providers hit the same proxy with different SDK packages — this is
what produces the two API paths:

| pi provider key | SDK | HTTP path | umans-gate path | TTL stamping? |
|-----------------|-----|-----------|-----------------|---------------|
| `umans-anthropic/<model>` | anthropic-messages | `POST /v1/messages` | Anthropic | **Yes** (when `stamp_claude_code_enabled: true`) |
| `umans/<model>` | openai-completions | `POST /v1/chat/completions` | OpenAI | No (Anthropic-only) |

> **Note:** pi's provider mapping is reversed from OpenCode's.
> In OpenCode, `umans/` = Anthropic and `umans-openai/` = OpenAI.
> In pi, `umans/` = OpenAI and `umans-anthropic/` = Anthropic.

Both point at `http://localhost:1945/v1`. Path differentiation is by SDK
package, not URL — confirmed in `src/proxy.ts:1604`.

## Prompt design

### Thinking level: `--thinking max`

All pi invocations use `--thinking max`. This forces pi to send:
- **Anthropic path**: `thinking: {"type":"enabled"}` in the request body
- **OpenAI path**: `reasoning_effort: "max"` in the request body

Without `--thinking max`, pi defaults to `thinking: {"type":"disabled"}`.
The proxy's `AnthropicBodyStep` only forces thinking if the body already
has a non-disabled thinking block (and `canDisableThinking` is false for
the model). For models where `canDisableThinking: true` (umans-flash,
umans-glm*), the proxy respects the disabled state — so without
`--thinking max`, those models never reason, and the benchmark measures
cache behavior without thinking tokens, which is not the production
scenario.

With `--thinking max`, all models reason at maximum effort in both passes.
Pass A (vanilla) sends `thinking: enabled` but no `output_config.effort`
(proxy stamping is off). Pass B (production) sends `thinking: enabled` +
`output_config: {effort: "max"}` (proxy stamps it).

### Why 10 turns

Per Anthropic docs (librarian research):
- **Turns 1–2**: write-heavy, not representative of steady state
- **Turns 3–5**: stabilization curve
- **Turns 6–10**: stable plateau — the regime we want to measure
- **20-block lookback window**: 10 turns × 2 blocks (user+assistant) = 20
  blocks, right at the edge. More than 10 turns needs a second breakpoint.

5 turns gives only 3–4 stable data points. 10 turns gives 5+. **10 is the
minimum for a clean signal.**

### Prompt differentiation strategy

**Problem:** If two sessions share an identical prefix (same system
prompt + same first user message), the second session hits the first
session's cache → cross-session contamination.

**Solution (from librarian research):** Shared system prompt + **unique
first user message per session**.

- **System prompt**: shared across all sessions (pi's agent prompt). This
  is the baseline cache benefit both passes get.
- **First user message**: includes a unique `{SESSION_TAG}` discriminator
  (e.g. `a-umans-coder-anthropic-lx8k3`). This breaks the message-level
  cache key across sessions → no cross-session message cache hits.
- **Turns 2–10**: follow-ups building on the shared system prefix.

### Prompt sequence

All prompts ask about cache mechanics and LLM API design — answerable
from general knowledge (no file reads), keeping tool-call overhead
minimal and the prefix stable.

| Turn | Topic | Cache behavior |
|------|-------|----------------|
| 1 | What is Anthropic prompt caching + TTL | Cold — cache write only |
| 2 | Cross-session cache sharing | System + turn-1 cached → first read |
| 3 | Multi-turn cache stabilization | Growing prefix |
| 4 | cache_creation vs cache_read tokens | Growing prefix |
| 5 | OpenAI vs Anthropic prefix caching | Stabilization zone |
| 6 | Minimum token threshold | Stable plateau begins |
| 7 | Proxy cache improvement | Stable plateau |
| 8 | Breakpoint limit behavior | Stable plateau |
| 9 | TTL expiry timing | Stable plateau |
| 10 | Key factors for max hit rate | Final measurement |

## Metrics (all numeric, no decompression)

The benchmark reads only plain numeric columns from `~/umans-gate.db`.
The zstd-compressed body/header columns are **not read** — no
decompression needed.

| Metric | SQL column | Meaning |
|--------|------------|---------|
| **Cache hit rate** | `cache_read_tokens / total_input_tokens * 100` | Primary signal (percentage) |
| Uncached input | `input_tokens` | Fresh input at full price |
| Cache reads | `cache_read_tokens` | Tokens read from cache (0.1x price) |
| Cache writes | `cache_creation_tokens` | Tokens written to cache (1.25x, Anthropic only) |
| Total input | `total_input_tokens` | `input + cache_creation + cache_read` (Anthropic) or `prompt_tokens` (OpenAI) |
| Output tokens | `total_output_tokens` | Response size |
| Thinking tokens | `thinking_tokens` | Reasoning overhead (subset of output) |
| **TTFT** | `ttft_ms` | Time-to-first-token (ms) — cache hits reduce this |
| **TPS** | `tps` | Tokens per second — sanity check (large drops suggest upstream throttling) |
| **Duration** | `duration_ms` | Full request latency |

### Hit rate formula

**Per-turn:** `cache_read_tokens / total_input_tokens * 100` (percentage 0–100)

**Per-cell aggregate:** `SUM(cache_read_tokens) / SUM(total_input_tokens) * 100`
— never `AVG(per_turn_rate)`, which is mathematically incorrect when turn
token counts vary.

This matches the proxy's own performance SQL in
`src/usage/ddl.ts:92-95` (`PERFORMANCE_STATS_SQL`).

### Expected results

| Metric | Pass A (vanilla) | Pass B (production) |
|--------|-------------------|---------------------|
| Turn 1 `cache_read_tokens` | 0 (cold) | 0 (cold) |
| Turn 2 `cache_read_tokens` | 0 or small (no TTL stamp → 5m default) | >0 (TTL `"1h"` stamp sustains prefix) |
| Turn 3–10 `cache_read_tokens` | Limited by 5m default TTL | Growing, sustained by 1h TTL + per-model thinking shapes |
| Turn 6–10 avg hit rate | Lower | Higher (full stamp bundle) |
| TTFT turn 1 | Baseline | Baseline (cold) |
| TTFT turn 2–10 | Reduced by upstream auto-cache | Reduced more (larger cached prefix from stamping) |

**Signal:** Pass B turns 6–10 `hit_pct` materially higher than Pass A
turns 6–10 `hit_pct` → the full production stamp bundle earns its cost.

## Config reload safety (live session)

The harness runs against a **live umans-gate instance** — the same one
serving this session. Config reloads are hot (no restart), but we protect
the live session:

1. **Save original config**: Before the benchmark, `GET /dashboard/api/config`
   saves all fields the harness will modify (`stamp_claude_code_enabled`,
   `stamp_reasoning_effort_enabled`, `stamp_model_rules`, `experiment_*`).
2. **Wait for quiet**: Before each config toggle, poll
   `GET /dashboard/api/gate` for the `active` field (in-flight permit
   count, `src/limiter/gate.ts:561`). Wait until active = 0, then wait 2s
   more to confirm. Warns and proceeds after 30s timeout — toggle is safe
   between requests (stamp config read once per request).
3. **Save config**: `POST /dashboard/api/config` writes the config file
   via `saveConfigLocked` (`src/viewer.ts:451`). This does NOT hot-reload
   the live proxy.
4. **Hot-reload**: `POST /dashboard/api/config/reload` explicitly triggers
   `applyReloadToConfig` into the live `ProxyConfig` (`src/viewer.ts:547`).
   The harness verifies `result.applied` contains all modified fields.
5. **Confirm all fields**: `GET /dashboard/api/config` verifies every field
   matches the expected value — not just `stamp_claude_code_enabled`.
6. **Settle delay**: Wait 3s after reload for the config to propagate
   to the per-request read path.
7. **Restore after run**: In a `finally` block (runs even on error/Ctrl-C),
   the harness restores the original saved config via save + reload.

The stamp fields are read per-request from the live `ProxyConfig`, so a
toggle between requests is safe. The risk is toggling *during* a request
— the `waitForQuiet` + 2s confirmation window eliminates this.

## Output

Each run produces two CSVs:

1. **Detail CSV** (`benchmark-<timestamp>.csv`) — one row per request (100
   rows for full, 30 for smoke). Columns: pass, model, path, turn,
   session_id, capture_id, input_tokens, cache_read_tokens,
   cache_creation_tokens, total_input_tokens, total_output_tokens,
   thinking_tokens, ttft_ms, tps, duration_ms, hit_rate_pct, error.

2. **Aggregate CSV** (`benchmark-<timestamp>-agg.csv`) — one row per cell
   (10 rows for full, 10 for smoke). Columns: pass, model, path,
   valid_turns, agg_hit_pct (SUM-based), total_input, total_output,
   total_cached, total_uncached, total_cache_create, mean_ttft_ms,
   median_ttft_ms, min_ttft_ms, max_ttft_ms, mean_tps, mean_duration_ms.

Console summary also prints per-cell: turn1/turnN/avg/plateau/agg hit%,
avg TTFT, avg TPS, total in/out/cached/uncached.

## Run protocol

### Prerequisites

- [ ] umans-gate running: `curl http://localhost:1945/health`
- [ ] pi CLI installed: `pi --version` (v0.83.0+)
- [ ] `~/.pi/agent/models.json` has `umans/` and `umans-anthropic/`
      providers pointing at `http://localhost:1945/v1`
- [ ] `vision_strategy: never` for the run (or the harness filters
      `is_vision = 0` automatically)
- [ ] Your production config is the config you want to measure in pass B.
      The harness saves and restores it — no manual config backup needed.

### Running the harness

```bash
# Smoke (validates harness, ~5-10 min with 6 parallel workers)
python3 -u benchmark/stamp-proxy-perf-smoke/harness.py

# Full (real data, ~25-40 min with 6 parallel workers)
python3 -u benchmark/stamp-proxy-perf/harness.py

# Single pass only
python3 -u benchmark/stamp-proxy-perf/harness.py --pass a

# Dry run (no calls)
python3 -u benchmark/stamp-proxy-perf/harness.py --dry-run

# Just print the collection SQL
python3 -u benchmark/stamp-proxy-perf/harness.py --collect

# Serial mode (1 cell at a time — slower but simpler debug)
python3 -u benchmark/stamp-proxy-perf/harness.py --workers 1

# Custom parallelism (e.g. 3 workers if concurrency is tight)
python3 -u benchmark/stamp-proxy-perf/harness.py --workers 3
```

> Always use `python3 -u` (unbuffered) so output streams live.

### Parallelism

Cells run in parallel by default (`--workers 6`). Each cell = one
model+path combination with its own pi session. Turns within a cell stay
serial (session continuation requires sequential turns), but the 6 cells
are independent — no shared cache keys between them (different model or
different path = different upstream cache scope).

| Mode | `--workers` | Est. runtime (full) | Concurrency slots used |
|------|-------------|----------------------|------------------------|
| Parallel (default) | 6 | ~25-40 min | 6 concurrent |
| Serial | 1 | ~90-150 min | 1 |
| Custom | 3 | ~50-75 min | 3 |

With 16 concurrency slots on umans AI, 6 parallel workers leaves 10 slots
for the live session. If the live session is idle during the benchmark,
all 6 slots are available.

### Inter-pass cache expiry

Pass A uses 5m default TTL (no stamping). Between pass A and pass B,
the harness waits **10 minutes** (full) or **5 minutes** (smoke) to
guarantee the 5m cache expires:

```
Pass A (vanilla, 5m TTL) → wait 10 min → Pass B (production, 1h TTL + full bundle)
```

This ensures pass B starts with a cold cache. Pass B's 1h TTL means its
cache persists for 1 hour — if you need to run pass A again after pass B,
wait 75 minutes.

### Config save and restore

The harness automatically:
1. Saves your current config before the benchmark
2. Toggles to pass A config (everything OFF)
3. Runs pass A
4. Waits for cache expiry
5. Toggles to pass B config (your saved production config with stamping ON)
6. Runs pass B
7. Restores your original config (even on error or Ctrl-C)

No manual config backup or restore needed.

### After the run

The harness writes to `benchmark/stamp-proxy-perf/results/`:
- `benchmark-<timestamp>.csv` — per-turn detail
- `benchmark-<timestamp>-agg.csv` — per-cell aggregate

Smoke harness writes to `benchmark/stamp-proxy-perf-smoke/results/`:
- `smoke-<timestamp>.csv` — per-turn detail
- `smoke-<timestamp>-agg.csv` — per-cell aggregate

## Analysis

### Primary comparison

The aggregate CSV has everything needed. For ad-hoc SQL against
`~/umans-gate.db`:

```sql
-- Per-pass, per-cell aggregate (filter by your run's time windows)
-- Pass A window: <start_a_ms> to <end_a_ms>
-- Pass B window: <start_b_ms> to <end_b_ms>
SELECT 'A' AS pass, model, path,
  COUNT(*) AS reqs,
  SUM(cache_read_tokens) AS total_cached,
  SUM(total_input_tokens) AS total_in,
  ROUND(100.0 * SUM(cache_read_tokens) / NULLIF(SUM(total_input_tokens), 0), 2) AS hit_pct,
  ROUND(AVG(ttft_ms), 1) AS avg_ttft
FROM captures WHERE started_at >= <start_a_ms> AND started_at <= <end_a_ms>
  AND is_vision = 0 AND state = 'done' AND usage_missing = 0
GROUP BY model, path
UNION ALL
SELECT 'B', model, path,
  COUNT(*), SUM(cache_read_tokens), SUM(total_input_tokens),
  ROUND(100.0 * SUM(cache_read_tokens) / NULLIF(SUM(total_input_tokens), 0), 2),
  ROUND(AVG(ttft_ms), 1)
FROM captures WHERE started_at >= <start_b_ms> AND started_at <= <end_b_ms>
  AND is_vision = 0 AND state = 'done' AND usage_missing = 0
GROUP BY model, path
ORDER BY model, path, pass;
```

### Key signals to look for

1. **Hit rate delta (A vs B)**: The primary signal. If B's turns 6–10
   avg hit rate is materially higher than A's, the full production stamp
   bundle works.
2. **TTFT delta**: Cache hits reduce TTFT. Compare avg TTFT turns 2–10
   between passes.
3. **Turn 1 always cold**: Both passes should show `cache_read_tokens = 0`
   on turn 1. If not, cross-session contamination occurred (the harness
   warns on this).
4. **Monotonic growth**: Within each session, `cache_read_tokens` should
   grow turn 1 → turn 10. Non-monotonic suggests cache eviction or prefix
   instability.
5. **OpenAI path**: Pass B has `stamp_reasoning_effort_enabled: true`,
   which mutates OpenAI path bodies (inject `reasoning_effort`, strip
   `output_config`/`context_management`). The OpenAI path is therefore
   not a pure control in this benchmark — it measures the full production
   effect including reasoning effort stamping. Compare the OpenAI
   A-vs-B delta to see reasoning effort's contribution to upstream
   auto-caching.

## Smoke test

`benchmark/stamp-proxy-perf-smoke/harness.py` — trimmed version for quick
validation before committing to the full ~25-40 min run.

| | Full | Smoke |
|---|---|---|
| Turns per cell | 10 | 3 |
| Inter-pass wait | 10 min | 5 min |
| Total requests | 100 | 30 |
| Est. runtime (parallel, 6 workers) | ~25-40 min | ~5-10 min |
| Est. runtime (serial, 1 worker) | ~90-150 min | ~20-25 min |

If the smoke test prints `RESULT: PASS`, the full harness is safe to run.
The smoke harness uses the same prompts (first 3), same config toggle
logic, same capture matching — just fewer turns and a shorter inter-pass
wait.

## Reproducibility

- **pi CLI version**: record exact version (`pi --version`). pi's system
  prompt and tool-definition prefix affect cacheable prefix size.
- **Model availability**: confirm all 3 models live via
  `curl http://localhost:1945/v1/models` before starting.
- **Concurrency**: harness parallelizes cells by default (`--workers 6`).
  Each cell has a unique (model, path) pair so no cross-cell cache
  contamination. Use `--workers 1` for serial mode.
- **Config state**: the harness saves and restores your production config
  automatically. Pass B uses whatever you had ON before the run — if you
  change your `stamp_model_rules` or experiment flags between runs, pass B
  changes too.
- **Inter-turn delay**: harness waits 2s between turns. Keep this < 5 min
  so Anthropic's 5m TTL stays warm within a session.
- **DB path**: proxy runs from home dir, so `./umans-gate.db` resolves to
  `~/umans-gate.db`. The harness uses `os.path.expanduser("~/umans-gate.db")`
  to read the correct file.
- **Ring buffer**: the harness checks `max_captures` at startup and warns
  if it's too small for the benchmark + live traffic. Default 200 is
usually enough for the smoke test (30 reqs). For the full benchmark
(100 reqs) with active live traffic, consider raising to 500+ (requires
  proxy restart — `max_captures` is a `restartRequired` field).

## File layout

```
benchmark/
├── stamp-proxy-perf/           ← full benchmark
│   ├── README.md               ← this file
│   ├── harness.py              ← Python + pi CLI harness
│   └── results/
│       ├── benchmark-<timestamp>.csv       ← per-turn detail
│       └── benchmark-<timestamp>-agg.csv   ← per-cell aggregate
├── stamp-proxy-perf-smoke/     ← smoke test (trimmed)
│   ├── harness.py
│   └── results/
│       ├── smoke-<timestamp>.csv
│       └── smoke-<timestamp>-agg.csv
├── benchmarks/                 ← old Python benchmarks (untouched)
└── ...
```

Old Python benchmarks remain in `benchmark/benchmarks/` and `scripts/` —
untouched, separate concern.
