# Cache Hit-Rate Benchmark

> **Applies to:** umans-gate v0.5.10+ · **Harness:** OpenCode CLI (opencode
> v1.18.9, non-interactive `opencode run` with `--session` continuation) ·
> **Collector:** SQLite (`./umans-gate.db`, the proxy's own capture
> ring buffer) · **Language:** Bun/TypeScript harness script (Bun-native,
> matches repo runtime, no extra toolchain).

## Purpose

Measure how `stamp_claude_code_enabled` (the Claude Code stamp bundle:
TTL `"1h"`, `top_k`, `max_tokens`, `thinking`, `output_config`,
`context_management`, `temperature`) affects LLM KV-cache hit rates across
6 models × 2 provider paths × 3 conversation turns, with experimental
flags toggled OFF vs ON.

Two passes, same matrix:

| Pass | `stamp_claude_code_enabled` | `stamp_reasoning_effort_enabled` | `experiment_*` flags |
|------|-----------------------------|----------------------------------|----------------------|
| A (baseline) | `false` | `false` | all `false` |
| B (stamped) | `true` | `true` | all `false` (isolates stamping; run C for experiment isolation) |
| C (experiments, optional) | `true` | `true` | `experiment_strip_omo_reminder: true`, others per hypothesis |

Pass A vs B isolates the stamping contribution to cache hit rate. Pass C
extends B with experimental flags to measure their marginal effect. This
document covers A and B (72 requests each, 144 total). Add C only after
A/B produce a clean signal.

## Why OpenCode CLI is the harness

The benchmark must drive a **real agent harness** that emits Anthropic and
OpenAI-shaped traffic through umans-gate — not a synthetic curl script,
because the goal is to measure cache behavior under realistic harness
prefix accumulation (system prompt + tool definitions + prior turns).

OpenCode CLI (v1.18.9, confirmed via `opencode --version`) supports:

- `opencode run "prompt" --format json --model <provider/model>` —
  non-interactive single-turn, emits NDJSON with `sessionID` in every
  event. Confirmed via `opencode run --help`.
- `opencode run -s <sessionID> "prompt"` — append to an existing session
  (multi-turn, same context prefix). Confirmed: `-s` / `--session` flag
  documented on both `opencode` and `opencode run`.
- `opencode run -c "prompt"` — continue the last session (alternative to
  `-s` when only one session is active).
- Per-invocation `--model` switching without a fresh session — the model
  argument overrides the session default for that single prompt.
- `opencode serve --port 4096` — headless HTTP server with a REST API
  (`POST /session`, `POST /session/:id/message`, SSE event stream) for
  fully programmatic driving without subprocess overhead per turn.

This runbook uses the **subprocess pattern** (`opencode run -s`) because
it is simpler to script, parallelize, and debug, and the per-turn Bun
startup cost (~200ms) is negligible next to LLM latency (seconds).

## Provider / model configuration

OpenCode routes to umans-gate via `opencode.json` provider `baseURL`. The
benchmark uses the existing `~/.config/opencode/opencode.json`, which
already defines two providers hitting the same proxy with different SDK
packages — this is what produces the two API paths:

| OpenCode provider key | npm SDK | HTTP path emitted | umans-gate path | TTL stamping runs? |
|-----------------------|---------|-------------------|-----------------|--------------------|
| `umans` | `@ai-sdk/anthropic` | `POST /v1/messages` | Anthropic | **Yes** (when `stamp_claude_code_enabled: true`) |
| `umans-openai` | `@ai-sdk/openai-compatible` | `POST /v1/chat/completions` | OpenAI | No (TTL stamp is Anthropic-only; OpenAI path gets `reasoning_effort` stamp when `stamp_reasoning_effort_enabled: true`) |

Both providers point at `http://localhost:1945/v1` with the same API key.
The path differentiation is purely by SDK package, not URL — confirmed in
the existing config and in `src/proxy.ts:1604`
(`isOpenAi = url.pathname.includes(config.openaiPath)` where
`openaiPath = "chat/completions"`).

### 6 models (from the existing opencode.json)

| # | Model ID | Family | Provider path keys |
|---|----------|--------|--------------------|
| 1 | `umans-coder` | kimi | `umans/umans-coder`, `umans-openai/umans-coder` |
| 2 | `umans-kimi-k2.7` | kimi | `umans/umans-kimi-k2.7`, `umans-openai/umans-kimi-k2.7` |
| 3 | `umans-kimi-k3` | kimi | `umans/umans-kimi-k3`, `umans-openai/umans-kimi-k3` |
| 4 | `umans-glm-5.2` | glm | `umans/umans-glm-5.2`, `umans-openai/umans-glm-5.2` |
| 5 | `umans-flash` | qwen | `umans/umans-flash`, `umans-openai/umans-flash` |
| 6 | `umans-qwen3.6-35b-a3b` | qwen | `umans/umans-qwen3.6-35b-a3b`, `umans-openai/umans-qwen3.6-35b-a3b` |

Each model is tested on **both** paths (Anthropic + OpenAI) = 12 cells.
3 turns per cell = 36 requests per pass. Two passes (A + B) = **72
requests total**.

## Prompt sequence (same per session, 3 turns)

The prompt is designed so the **prefix is stable across turns** — this is
what warms the cache. The system prompt is set once by OpenCode (via the
agent config); each user turn appends to the same conversation.

### Turn 1 (cold — builds the cached prefix)

```
Review src/stamp.ts. Explain what stampCacheTtl does, line by line, and
why it mutates the body in place. Reference the ephemeral block type and
the default TTL value. Keep the answer under 200 words and cite file
paths.
```

### Turn 2 (prefix now cached: system + turn 1 + assistant reply 1)

```
Now review src/stamp-pipeline.ts. List the stamp steps in pipeline order
and explain how StampContext.isOpenAi gates which steps run. Use the
same project context. Under 200 words, cite file paths.
```

### Turn 3 (longest prefix — should show the highest cache read)

```
Finally, review src/proxy.ts phase 1 (parseInbound). Explain how isOpenAi
and isAnthropicMessages are derived from the URL and how stampBeta is
gated. Use the same project context. Under 200 words, cite file paths.
```

### Why this prompt works for caching

- OpenCode's agent system prompt (tool definitions + agent instructions)
  is ~2–4k tokens and is sent on every turn as a stable prefix — clears
  the Anthropic 1024-token cache threshold from turn 1.
- Turn 1's user + assistant messages join the prefix for turn 2 →
  `cache_read_input_tokens > 0` on turn 2 (Anthropic path).
- Turn 3 has the longest stable prefix (system + turns 1–2 + replies) →
  highest `cache_read_input_tokens`.
- A healthy stamping run shows monotonic growth in `cache_read_tokens`
  across turns 1 → 2 → 3 on the Anthropic path. The OpenAI path is a
  control: any `cached_tokens` there is upstream auto-caching, not
  umans-gate stamping.

## Harness architecture

### Recommended: Bun/TypeScript subprocess harness

**Why Bun/TS over Python:** the repo is Bun-native (Bun-only runtime via
`bun:sqlite`), the proxy's SQLite schema is already documented in
`src/db.ts`, and a Bun script can query `./umans-gate.db` directly with
`bun:sqlite` — zero extra toolchain, no `pip install`, no driver mismatch.
Python would work but adds a second runtime for no gain.

**Harness responsibilities:**

1. For each pass (A baseline, B stamped):
   a. Toggle umans-gate config via `POST /dashboard/api/config` (hot-reload
      endpoint — confirmed in `src/config/file.ts:saveConfig` and the
      dashboard's `useConfig().save()` in
      `dashboard/src/hooks/use-config.ts`). Fields
      `stamp_claude_code_enabled` and `stamp_reasoning_effort_enabled` are
      hot-reloadable (not in `RESTART_REQUIRED_FIELDS`), so no proxy
      restart between passes.
   b. Wait 2s for the reload to propagate (the dashboard does this
      implicitly; the harness should poll `GET /dashboard/api/config` and
      confirm the field reflects the new value before proceeding).
   c. For each of the 12 cells (6 models × 2 providers):
      i.  **Wait >65 minutes since the last request to this same model on
          this same path** if reusing a model across passes — Anthropic
          TTL is 1h, so a request within the hour would hit a stale cache
          and contaminate the measurement. In practice, run all 12 cells
          of pass A, then wait 65 min, then run pass B. Or use different
          model+path orderings between passes so no cell reuses a prefix
          inside its TTL window.
      ii. Send turn 1: `opencode run --model <provider/model> --format
          json "$TURN1" --auto` — capture `sessionID` from the first
          NDJSON event (`jq -r '.sessionID'` or parse in-script).
      iii. Send turn 2: `opencode run -s <sessionID> --model
           <provider/model> --format json "$TURN2" --auto`.
      iv. Send turn 3: same with `$TURN3`.
      v.  After turn 3 completes, record the 3 capture IDs (from the
          NDJSON `step_finish` events, or by querying
          `./umans-gate.db` filtered by `started_at` window and model).
   d. Serialize cells (no parallel sessions to the same model — avoids
      cache eviction under concurrency). Different models can run in
      parallel if the proxy's concurrency gate allows (soft limit 8), but
      for a clean cache measurement, serialize.

2. After both passes, run the collection SQL (below) and emit a results
   table + CSV.

### Why not `opencode serve` (HTTP API)

`opencode serve` is viable and avoids per-turn subprocess overhead, but:
- Requires managing server lifecycle + SSE parsing for completion
  detection.
- The subprocess pattern is 30 lines of `Bun.spawn` and trivially
  parallelizable across cells.
- Per-turn Bun startup (~200ms) is invisible next to LLM TTFT (seconds).

Prefer the subprocess pattern unless you intend to run hundreds of
repeats (then the server-mode overhead win matters).

### Config toggle via dashboard API

The harness toggles stamping between passes by calling the umans-gate
config endpoint (no restart needed — these fields are hot-reloadable):

```ts
// Pass A: baseline (stamping off)
await fetch("http://localhost:1945/dashboard/api/config", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    stamp_claude_code_enabled: false,
    stamp_reasoning_effort_enabled: false,
  }),
});

// Pass B: stamped
await fetch("http://localhost:1945/dashboard/api/config", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    stamp_claude_code_enabled: true,
    stamp_reasoning_effort_enabled: true,
  }),
});
```

If `DASHBOARD_TOKEN` is set, include
`Authorization: Bearer <token>` in the headers.

## Data collection (SQLite)

umans-gate captures every request/response to `./umans-gate.db`. The
harness does **not** need its own data store — it queries the proxy's
ring buffer. Relevant columns (from `src/db.ts` and
`src/usage/types.ts`):

| Column | Meaning |
|--------|---------|
| `id` | capture ID |
| `path` | `/v1/messages` (Anthropic) or `.../chat/completions` (OpenAI) |
| `model` | model name extracted from request body |
| `started_at` | epoch ms |
| `cache_creation_tokens` | Anthropic `cache_creation_input_tokens`; null on OpenAI |
| `cache_read_tokens` | Anthropic `cache_read_input_tokens`; OpenAI `prompt_tokens_details.cached_tokens` |
| `total_input_tokens` | input + cache_creation + cache_read (Anthropic) or `prompt_tokens` (OpenAI) |
| `total_output_tokens` | output tokens |
| `is_vision` | bool — filter `is_vision = 0` to exclude vision handoff captures |

### Collection SQL

Run after both passes complete. Adjust the time window to your run.

```sql
-- Per-capture detail (one row per request)
SELECT
  id,
  path,
  model,
  started_at,
  total_input_tokens,
  cache_creation_tokens,
  cache_read_tokens,
  total_output_tokens,
  ROUND(100.0 * cache_read_tokens / NULLIF(total_input_tokens, 0), 2) AS hit_pct
FROM captures
WHERE started_at >= strftime('%s', 'now', '-4 hours') * 1000
  AND is_vision = 0
ORDER BY started_at;

-- Per-cell aggregate (model × path × pass)
-- "pass" is inferred from the stamp_claude_code_enabled state at
-- started_at. For a clean split, tag captures by running the two passes
-- in distinct time windows and filtering on started_at ranges, OR add a
-- harness-side tag column (see "Tagging captures" below).
SELECT
  model,
  path,
  COUNT(*) AS reqs,
  SUM(total_input_tokens) AS total_in,
  SUM(cache_creation_tokens) AS total_created,
  SUM(cache_read_tokens) AS total_cached,
  ROUND(100.0 * SUM(cache_read_tokens) / NULLIF(SUM(total_input_tokens), 0), 2) AS hit_pct
FROM captures
WHERE started_at >= strftime('%s', 'now', '-4 hours') * 1000
  AND is_vision = 0
GROUP BY model, path
ORDER BY hit_pct DESC;
```

### Tagging captures (optional, cleaner)

To avoid time-window inference, the harness can write a tag into the
capture's `path` or a side table. The simplest approach without schema
changes: run pass A and pass B in distinct, non-overlapping time windows
and record the boundary timestamps in the harness output. Then filter
the SQL by `started_at` range per pass.

## Expected results

| Metric | Pass A (baseline) | Pass B (stamped) |
|--------|-------------------|------------------|
| Anthropic turn 1 `cache_read_tokens` | 0 (cold) | 0 (cold) |
| Anthropic turn 2 `cache_read_tokens` | 0 or small (no TTL → cache expires between turns if >5m) | > 0 (TTL 1h holds the prefix) |
| Anthropic turn 3 `cache_read_tokens` | 0 or small | ≥ turn 2 value (longer prefix cached) |
| OpenAI `cached_tokens` | upstream-dependent | upstream-dependent (stamping does not touch OpenAI cache) |
| Anthropic `cache_creation_tokens` turn 1 | 0 (no ephemeral block without stamping) | > 0 (stamp adds `cache_control: ephemeral`) |

**Signal:** the delta between pass A and pass B on the Anthropic path,
turns 2 and 3, is the stamping contribution to cache hit rate. If pass B
turn 3 `hit_pct` is materially higher than pass A turn 3 `hit_pct`, the
stamp bundle is earning its cost.

## Run protocol checklist

Before each pass:

- [ ] `bun run build` done (dashboard assets current — otherwise the
      proxy fails to start with a cryptic module error; see
      `test/helpers/proxy.ts` staleness check).
- [ ] umans-gate running (`umans-gate service status` or
      `curl http://localhost:1945/health`).
- [ ] `./umans-gate.db` backed up if you want to preserve prior captures
      (the ring buffer will evict old rows once `max_captures` is hit;
      raise it in config if you need all 72 rows retained —
      `max_captures: 500` is safe).
- [ ] `opencode.json` providers pointing at `http://localhost:1945/v1`
      (already configured in `~/.config/opencode/opencode.json`).
- [ ] No other OpenCode sessions active during the run (avoids cache
      contention and capture contamination).
- [ ] Config toggled to the pass's state and confirmed via
      `GET /dashboard/api/config`.

After each pass:

- [ ] Export the capture rows via the collection SQL.
- [ ] Record the pass's time window (start/end epoch ms) for later
      filtering.

Between pass A and pass B:

- [ ] Wait **>65 minutes** (Anthropic TTL is 1h; +5m margin) so pass B
      does not inherit pass A's cache. If you cannot wait, run the two
      passes on different days, or use different model+path orderings so
      no cell reuses a prefix inside its TTL window.

## Reproducibility notes

- **TTFT watchdog and experiment flags**: keep
  `experiment_ttft_watchdog`, `experiment_rewrite_ids`, and
  `experiment_strip_omo_reminder` all `false` for passes A and B. They
  confound cache measurement (retry changes the request count; OMO
  stripping changes the prefix). Isolate them in pass C if needed.
- **Vision**: set `vision_strategy: never` for the benchmark run, or
  filter `is_vision = 0` in the collection SQL. Vision handoff captures
  are separate rows and would contaminate the hit-rate math.
- **Concurrency**: serialize cells (one model+path at a time) to avoid
  cache eviction under load. The proxy's concurrency gate (soft limit 8)
  would otherwise allow parallel sessions to the same upstream account,
  and Anthropic may evict cache entries under concurrent pressure.
- **Model availability**: confirm all 6 models are live via
  `curl http://localhost:1945/v1/models` before starting. If a model is
  unavailable, drop it from the matrix rather than substituting —
  substituting changes the cache key space.
- **OpenCode version**: pin to v1.18.9 or record the exact version in
  the results. OpenCode's system prompt and tool-definition prefix
  affect the cacheable prefix size; a version bump can change results
  across runs.

## Reference: umans-gate internals relied on

| Component | File | Role in benchmark |
|-----------|------|-------------------|
| TTL stamping | `src/stamp.ts:stampCacheTtl` | Adds `ttl: "1h"` to `cache_control: ephemeral` blocks on Anthropic path when `stamp_claude_code_enabled` |
| Stamp pipeline | `src/stamp-pipeline.ts` | Orchestrates TTL + thinking + top_k + max_tokens + output_config stamps; gated by `StampContext.isOpenAi` |
| Path detection | `src/proxy.ts:1604` | `isOpenAi = url.pathname.includes("chat/completions")`; `isAnthropicMessages = !isOpenAi && pathname === "/v1/messages"` |
| Usage extraction | `src/usage/extract.ts:extractUsage` | Parses `cache_read_input_tokens` (Anthropic) / `prompt_tokens_details.cached_tokens` (OpenAI) into `UsageMetrics` |
| Capture storage | `src/db.ts` | Writes `cache_creation_tokens`, `cache_read_tokens`, `total_input_tokens` per capture |
| Config hot-reload | `src/config/reload.ts:applyReloadToConfig`, `src/config/file.ts:saveConfig` | `POST /dashboard/api/config` saves + hot-reloads; `stamp_claude_code_enabled` is hot-reloadable (not in `RESTART_REQUIRED_FIELDS`) |
| Hit-rate metric | `dashboard/src/components/usage-timeline.tsx:cacheHitRate` | `cache_read_tokens / (tokens_in + tokens_out + tokens_cached)` — the dashboard's definition; the collection SQL uses the simpler `cache_read / total_input` which is equivalent for hit-rate comparison |

## Reference: OpenCode CLI commands used

| Command | Purpose |
|---------|---------|
| `opencode run --model <provider/model> --format json --auto "prompt"` | Turn 1: create session, capture `sessionID` from first NDJSON event |
| `opencode run -s <sessionID> --model <provider/model> --format json --auto "prompt"` | Turns 2–3: append to same session |
| `opencode session list` | Verify no stray sessions before a run |
| `opencode export <sessionID>` | Post-run audit of what OpenCode sent (compare against umans-gate capture) |

`--auto` approves all non-denied permissions so the run is non-interactive.
`--format json` emits NDJSON events with `sessionID` on every line for
harness capture.
