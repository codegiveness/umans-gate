# umans-gate: stop guessing what your harness sends upstream

[![npm version](https://img.shields.io/npm/v/umans-gate.svg)](https://www.npmjs.com/package/umans-gate)
[![npm downloads](https://img.shields.io/npm/dm/umans-gate.svg)](https://www.npmjs.com/package/umans-gate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/codegiveness/umans-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/codegiveness/umans-gate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/codegiveness/umans-gate/actions/workflows/codeql.yml/badge.svg)](https://github.com/codegiveness/umans-gate/actions/workflows/codeql.yml)

**umans-gate** is a local capture proxy for LLM APIs that intercepts Anthropic and OpenAI-compatible traffic, stores every request and response in a SQLite ring buffer, and serves a live inspection dashboard over WebSocket. Run one command; point your agent harness at it; observe every byte on the wire.

*Personal-use project, MIT-licensed, maintained by [codegiveness](https://github.com/codegiveness). Not affiliated with, endorsed by, or an official product of Umans AI. Last updated: 2026-07-31 · Version 0.6.1.*

**Author:** [codegiveness](https://github.com/codegiveness), independent developer building LLM tooling and observability infrastructure. Source code published under MIT for transparency. No commercial support tier.

**Setup in 30 seconds.**

```bash
npm install -g umans-gate && umans-gate service install
```

This installs the proxy as a **background service** — it auto-starts on
boot, survives terminal close, and auto-restarts on crash. The proxy
listens on `http://localhost:1945`. The dashboard is served at
`http://localhost:1945/dashboard/`. Point any Anthropic or
OpenAI-compatible harness at the proxy URL. Every request and response
is captured to SQLite.

## What is umans-gate?

umans-gate is a **local LLM API capture proxy** that sits between an agent harness and the upstream LLM provider, stores every request and response in a SQLite ring buffer, and exposes a React dashboard with live WebSocket updates for inspecting traffic, cache behavior, and usage economics. It runs on Bun, requires no client-side code changes, and captures Anthropic and OpenAI-compatible endpoints in a single process.

## Who should use umans-gate?

- **umans.ai users** who need visibility into API traffic, cache control
  TTL behavior, and per-request token economics.
- **Agent harness users** who must inspect and debug what their harness
  sends upstream: stamp pipeline output, thinking blocks, vision handoff.
- **Developers** integrating Anthropic or OpenAI-compatible APIs who need
  traffic capture, concurrency gating, and rate-limit validation in one
  local tool.

## Features

| Feature | Description |
|---------|-------------|
| **Capture proxy** | Intercepts LLM API traffic (Anthropic + OpenAI-compatible); stores in SQLite with optional zstd compression |
| **Stamp pipeline** | Applies TTL, `top_k`, `max_tokens`, `thinking`, `output_config`, `context_management`, `temperature` stamps. Two toggles (Anthropic / OpenAI). |
| **Vision handoff** | Replaces image blocks with text descriptions from a vision model; cached 7 days with persistent SQLite storage |
| **Concurrency gate** | Semaphore + circuit breaker with intention-based reservations; hard cap and soft limit auto-sized from `/v1/usage`; queue timeout |
| **Rate limiting** | Sliding-window weighted rate limiter; auto-derived from `/v1/usage` or explicit configuration |
| **Connection warmer** | Periodic `/v1/models` pings keep TLS warm; skips when real traffic occurred recently |
| **Usage tracking** | Fetches `/v1/usage` to size concurrency, detect rate-boxing, manage priority demotion |
| **Live inspector** | React + shadcn/ui dashboard with WebSocket live updates |
| **SSE rendering** | Streaming responses captured and rendered with expandable event previews |
| **Ring buffer storage** | Last N captures (default 200) in WAL-mode SQLite |
| **Write-behind queue** | Batched DB writes to minimize blocking during streaming |
| **Hop-by-hop header stripping** | Correct HTTP proxy behavior per RFC 7230 |
| **Protocol flexibility** | Upstream HTTP/1.1 (default) or HTTP/2 |

## Important notes

1. **The proxy modifies your requests.** Stamping is on by default
   (`STAMP_CLAUDE_CODE_ENABLED` and `STAMP_REASONING_EFFORT_ENABLED` both
   default to `true`), so the proxy rewrites request bodies before
   forwarding upstream. The stamped body is what gets sent upstream AND
   captured. The proxy also forces `accept-encoding: identity` and strips
   `content-encoding` unconditionally. Toggle stamping off in the Config
   tab if you need a clean passthrough.
2. **Vision strategy and non-Claude Code harnesses.** When
   `VISION_STRATEGY` is `never`, or a vision-capable model under `catalog`,
   images pass through untouched. Do NOT configure the model as
   vision-capable on the harness side (except Claude Code). With the default
   `catalog` strategy, a cache miss halts the request, calls the vision
   model to describe the image, rewrites the body with the text
   description, then forwards — so non-vision models receive text they can
   process. Subsequent requests for the same image hit the cache and skip
   the vision call.
3. **Upstream target is hardcoded.** Forwards to
   `https://api.code.umans.ai`. OpenAI chat path, warmer path, and vision
   target are also hardcoded, not configurable. Listen address is hardcoded
   to `127.0.0.1` (loopback only).
4. **Ring buffer overwrites old captures.** Keeps only the last N (default
   `MAX_CAPTURES=200`). Increase in config for longer history.
5. **API key unlocks key features.** Without `UMANS_API_KEY`, the proxy
   still captures traffic, but `/v1/usage` polling, concurrency gate sizing,
   rate-limit validation, and vision handoff stay disabled.
6. **Service install recommended.** Without `service install`,
   `umans-gate` runs in the foreground and won't survive reboots or
   terminal close. Run `umans-gate service install` to register as a
   managed service.
7. **Default concurrency and the hard cap toggle.** `CONCURRENCY_HARD_CAP`
   defaults to `16`, `CONCURRENCY_SOFT_LIMIT` to `8`. By default
   (`USE_HARD_CAP=true`), the effective limit is the hard cap. Both are
   auto-sized from `/v1/usage` when `UMANS_API_KEY` is set. Toggle in the
   dashboard Config tab. No restart needed.

## Usage rights

**Personal-use project** with architecture modeled on production patterns
but single-maintainer support. Source published under MIT for transparency
and educational purposes. No guaranteed response time. No
backward-compatibility commitment across versions; config shapes, flags,
and APIs may change between releases without a deprecation cycle. No
production support tier, no SLA. Security vulnerabilities are the one
exception: see [SECURITY.md](SECURITY.md) for the 48-hour acknowledgment
SLA on confirmed reports.

**Not an official Umans product.** Not affiliated with, endorsed by, or
supported by Umans AI. All upstream service names, model names, and API
endpoints belong to their respective owners.

## How to install umans-gate

umans-gate ships as a pre-compiled npm binary and a standalone Bun/TypeScript source. The npm path requires no prerequisites; the Bun path requires Bun ≥ 1.1.0.

**npm (recommended):**

```bash
npm install -g umans-gate && umans-gate service install
```

The `service install` step registers umans-gate as a background service —
it auto-starts on boot and survives terminal close. If you skip it,
`umans-gate` runs in the foreground and dies when you close your terminal.

**npx (temporary, no install):**

```bash
npx umans-gate
```

> ⚠️ `npx` runs a temporary instance that dies when you close the
> terminal. Don't use it for regular use — install with `npm install -g`
> and `service install` instead.

**Bun (for developers):**

```bash
git clone https://github.com/codegiveness/umans-gate.git
cd umans-gate && bun install && bun src/cli.ts
```

> No prerequisites for npm/npx. The package bundles a pre-compiled binary.
> For development, [Bun](https://bun.sh) ≥ 1.1.0 is required.

### Platform support

| OS | Arch | npm Package |
|----|------|-------------|
| macOS | arm64/x64 | `umans-gate-darwin-{arm64,x64}` |
| Linux | x64/arm64 | `umans-gate-linux-{x64,arm64}` |
| Windows | x64/arm64 | `umans-gate-win32-{x64,arm64}` |

## How to use umans-gate

Point any Anthropic or OpenAI-compatible agent harness at the proxy URL (`http://localhost:1945`). Every request and response is captured to SQLite and visible in the live dashboard at `/dashboard/`.

1. **Start the proxy:** `umans-gate service install` (installs as
   background service — auto-starts on boot, survives terminal close).
   Already installed? Start it with `umans-gate service start`.
2. **Point your harness** to `http://localhost:1945`:

   ```bash
   export ANTHROPIC_BASE_URL=http://localhost:1945
   export OPENAI_BASE_URL=http://localhost:1945
   ```

3. **Open the dashboard** at `http://localhost:1945/dashboard/`
4. **Set your API key** (optional but recommended):

   ```bash
   export UMANS_API_KEY=your-key-here
   # Or edit config.json: umans-gate config show
   # Or use the dashboard Config tab
   ```

   Enables `/v1/usage` polling, concurrency gate sizing, rate-limit
   validation, and vision handoff.

5. **Secure the dashboard** (optional): `export DASHBOARD_TOKEN=your-secret-token`.
   When set, all `/dashboard/api/*` routes, `/health`, and `/metrics`
   require `Authorization: Bearer <token>`. WebSocket requires
   `?token=<token>`. Includes brute-force protection.

6. **Make it survive reboots:** `umans-gate service install` (already
   done if you followed the install steps above; this is just for
   reference).

## Updating

```bash
umans-gate update          # self-update (npm global or standalone binary)
umans-gate update --check # check without installing
umans-gate uninstall      # removes service, config, database, binary
```

The updater detects install method and acts accordingly. If running as a
managed service, stops before update and restarts after. Pass `--keep-config`
to preserve `config.json` and the database.

## Service persistence

```bash
umans-gate service install        # register as managed service
umans-gate service install --force # overwrite existing definition
umans-gate service start|stop|restart|status|logs|uninstall
```

| Platform | Service manager | Unit location |
|----------|----------------|---------------|
| Linux | systemd (user unit + linger) | `~/.config/systemd/user/umans-gate.service` |
| macOS | launchd (LaunchAgent) | `~/Library/LaunchAgents/com.umans.gate.plist` |
| Windows | Windows Service (via NSSM) | Registered with `sc.exe` |

The service uses `Restart=always` / `KeepAlive=true` and auto-starts on
boot. API keys set via env var are stored securely (separate
`EnvironmentFile` with `chmod 600` on systemd, in the plist on launchd, in
the service registry on Windows). When running as a managed service, the
dashboard **Restart** button works automatically.

## How configuration works

umans-gate loads configuration from a JSON file with environment variable overrides. On first run, `loadConfig()` writes defaults if the file does not exist; existing configs are never overwritten. All env vars have `snake_case` JSON equivalents. Precedence, highest to lowest: env vars > JSON config > built-in defaults.

> **Dashboard-first:** Edit config via the **Config** tab at
> `http://localhost:1945/dashboard/`. The dashboard validates, shows field
> descriptions, and can hot-reload or restart.

| OS | Path |
|----|------|
| Linux/macOS | `$XDG_CONFIG_HOME/umans-gate/config.json` or `~/.config/umans-gate/config.json` |
| Windows | `%APPDATA%/umans-gate/config.json` |

**Precedence (highest to lowest):** env vars > JSON config > built-in defaults.

### Key config fields

| Variable | Default | Description |
|---|---|---|
| `PORT` | `1945` | Listen port |
| `MAX_CAPTURES` | `200` | Ring buffer size |
| `DB_PATH` | `./umans-gate.db` | SQLite database path |
| `UPSTREAM_PROTOCOL` | `http1.1` | `http1.1` or `http2` |
| `UPSTREAM_TIMEOUT_MS` | `1800000` | Upstream fetch timeout (30 min) |
| `STAMP_CLAUDE_CODE_ENABLED` | `true` | Toggle Claude Code stamp bundle (Anthropic) |
| `STAMP_REASONING_EFFORT_ENABLED` | `true` | Toggle `reasoning_effort` stamping (OpenAI) |
| `STAMP_MODEL_RULES` | `[]` | Per-model thinking-shape rules table (ADR-0029, hot-reloadable) |
| `UMANS_API_KEY` | _(empty)_ | Unlocks `/v1/usage`, gate sizing, rate-limit, vision |
| `DASHBOARD_TOKEN` | _(empty)_ | Secures dashboard + `/health` + `/metrics` + WS |
| `CONCURRENCY_HARD_CAP` | `16` | Max concurrent upstream (auto from `/v1/usage`) |
| `CONCURRENCY_SOFT_LIMIT` | `8` | Soft limit (auto from `/v1/usage`) |
| `USE_HARD_CAP` | `true` | `true` = use hard cap; `false` = use soft limit |
| `VISION_STRATEGY` | `catalog` | `never`, `catalog`, or `always` |
| `VISION_MODEL` | `umans-flash` | Vision model for image description |
| `BREAKER_THRESHOLD` | `5` | Circuit breaker failure threshold |
| `RATE_LIMIT_REQUESTS` | `0` | `0` = auto, `-1` = unlimited, `N` = explicit |

See [AGENTS.md](AGENTS.md) for the complete config field table.

### Hot reload

The Config tab can save and hot-reload via
`POST /dashboard/api/config/reload`. Hot-reloadable: all fields except
those marked `restartRequired` (e.g. `port`, `db_path`, `upstream_protocol`,
`vision_strategy`, `vision_model`, `warmer_*`, `umans_api_key`,
`dashboard_token`). The full set of hot-reloadable fields is defined in
`src/config/reload.ts` (`RELOAD_FIELDS`). Fields marked `restartRequired`
require a server restart.

### How the stamp pipeline works

When `STAMP_CLAUDE_CODE_ENABLED` is `true`, the proxy applies the following stamps to Anthropic requests before forwarding upstream. The stamped body is what gets sent upstream AND what gets captured. The inspector shows exactly what went to the API.

- **TTL**: `"1h"` on `cache_control` ephemeral blocks
- **`top_k`**: `20`
- **`temperature`**: `1.0`
- **`max_tokens`**: `131071` for `umans-glm*` models, `32767` for others
- **`thinking`**: `{ "type": "adaptive" }` as the overlay default; per-model shapes via `STAMP_MODEL_RULES` (ADR-0029)
- **`output_config`**: effort `high` or `max`
- **`context_management`**: `clear_thinking`

**Per-model rules** (`STAMP_MODEL_RULES`, ADR-0029): a config-driven rules
table that overrides the adaptive thinking shape per model family on both
Anthropic and OpenAI routes. Each rule matches a model name pattern (glob,
first-match-wins) and can set `anthropic_thinking_shape`,
`openai_thinking_shape`, `openai_extra_body`, and
`openai_veto_reasoning_effort`. Rules are independent of the master toggles
and hot-reloadable. See [ADR-0029](docs/adr/0029-per-model-stamp-rules-table.md)
for the full spec and target table.

For OpenAI-compatible requests, `STAMP_REASONING_EFFORT_ENABLED` injects
`reasoning_effort`, strips `output_config` and `context_management`, and
forces `temperature: 1.0`. The `thinking` field is controlled by
`STAMP_MODEL_RULES` (`PerModelRuleStep`), not by `reasoning_effort`
stamping.

### How vision handoff works

The vision handoff replaces image blocks in requests with text descriptions generated by a vision model. This reduces token cost and enables text-only models to process image-bearing requests. Descriptions are cached for 7 days in persistent SQLite storage.

**Strategies** (`VISION_STRATEGY`):

| Strategy | Behavior |
|----------|----------|
| `catalog` (default) | Replace images only if the target model lacks vision capability |
| `always` | Always replace images with text descriptions |
| `never` | Never replace images; pass through untouched |

**Intent-aware prompting** (`VISION_INTENT_STRATEGY`, default `auto`):
accepts `off`, `slotted`, `crafted`, or `auto`. When `auto`, a
deterministic triage function routes each request to one of four
strategies (`generic`, `slotted`, `crafted`, `decomposed`) based on
adjacent text, image count, and tool-result status. `off` forces
`generic` only. Vision calls are serialized by the concurrency gate
(default concurrency = 4). Descriptions are cached for 7 days in
persistent SQLite storage.

### How the concurrency gate works

The concurrency gate regulates upstream parallelism using three mechanisms: a semaphore enforcing soft/hard limits, a circuit breaker for failure isolation, and intention-based reservations with a bounded queue.

1. **Semaphore**: enforces a soft limit and a hard cap on concurrent
   upstream requests. Both are auto-sized from `/v1/usage` when
   `UMANS_API_KEY` is set.
2. **Circuit breaker**: opens after `BREAKER_THRESHOLD` (default `5`)
   HTTP 429 responses within `BREAKER_WINDOW_MS` (default 5 minutes),
   blocks traffic for `BREAKER_COOLDOWN_MS` (default 60 seconds), then
   half-opens to probe recovery.
3. **Intention-based reservations + queue**: main and vision lanes hold
   reserved slots; excess requests enter a bounded queue
   (`MAX_QUEUE_DEPTH`, default 100) with a timeout
   (`QUEUE_TIMEOUT_MS`, default 180 seconds).

### How rate limiting works

The rate limiter is a sliding-window weighted counter with three modes:

| `RATE_LIMIT_REQUESTS` | Behavior |
|-----------------------|----------|
| `0` (default) | Auto-derived from `/v1/usage` |
| `-1` | Unlimited (no limiting) |
| `N` (positive integer) | Explicit weighted sliding window of `N` requests |

Window size is derived from `/v1/usage` when available.

## Programmatic API

```typescript
import { createProxyServer } from "umans-gate";

const server = createProxyServer({
  config: { port: 8080 },
});

// server.db    : CaptureDB instance
// server.ws    : WsBroadcaster instance
// server.queue : WriteQueue instance
// server.shutdown(): graceful shutdown
```

## Development

```bash
bun run dev             # start proxy server
bun run typecheck       # TypeScript checking
bun run lint            # Biome lint
bun run lint:fix       # Biome lint + auto-fix
bun run test            # server tests
bun run test:dashboard  # dashboard tests (vitest + jsdom)
bun run test:all        # server + dashboard tests
bun run build           # build server (tsup) + dashboard (vite)
```

## FAQ

### Is umans-gate free?

Yes. umans-gate is MIT-licensed and free to use, modify, and distribute. The npm package (`npm install -g umans-gate`) and standalone binaries are free. No paid tier, no feature gating. Source code is public on [GitHub](https://github.com/codegiveness/umans-gate).

### Does umans-gate work with Claude Code?

Yes. umans-gate intercepts Anthropic API traffic, which is what Claude Code uses. Point `ANTHROPIC_BASE_URL` at the proxy (`http://localhost:1945`) and every request is captured. The stamp pipeline (`STAMP_CLAUDE_CODE_ENABLED=true`) applies TTL, `top_k`, `temperature`, `max_tokens`, `thinking`, `output_config`, and `context_management` stamps to Anthropic requests.

### Does umans-gate work with OpenAI-compatible APIs?

Yes. The proxy intercepts OpenAI-compatible traffic on `/v1/chat/completions`. With `STAMP_REASONING_EFFORT_ENABLED=true`, it injects `reasoning_effort`, strips `output_config` and `context_management`, and forces `temperature: 1.0`. The `thinking` field is controlled by `STAMP_MODEL_RULES` (per-model rules, ADR-0029), not by `reasoning_effort` stamping.

### What is the difference between umans-gate and a regular HTTP proxy?

> ⚠️ Experimental: enabled by `stamp_claude_code_enabled` (default: on)

A regular HTTP proxy forwards traffic. umans-gate captures every request/response pair to SQLite, stamps `ttl` onto `cache_control` ephemeral blocks, runs a vision handoff pipeline (image → text description), enforces concurrency limits with a circuit breaker, and serves a live React dashboard over WebSocket. It is purpose-built for LLM API traffic observation and optimization.

### Does umans-gate modify my requests?

By default, the proxy applies minor body modifications: it strips oh-my-openagent's `[Category+Skill Reminder]` text blocks from Anthropic requests (`EXPERIMENT_STRIP_OMO_REMINDER`, default: on), and it always forces `accept-encoding: identity` and strips `content-encoding` for capture safety. Full stamping (`STAMP_CLAUDE_CODE_ENABLED` for Anthropic, `STAMP_REASONING_EFFORT_ENABLED` for OpenAI) is **on by default** — the proxy rewrites request bodies (TTL, thinking, max_tokens, etc.) before forwarding upstream, and the stamped body is what gets captured. Toggle any of these off in the Config tab for a clean passthrough.

### What is the ring buffer and how many captures does it store?

The ring buffer is a SQLite table capped at `MAX_CAPTURES` (default 200). When the limit is reached, the oldest captures are evicted. Increase `MAX_CAPTURES` in config for longer history. Bodies are optionally compressed with zstd, and `capture_body_max_bytes` (default 10 MB) limits per-capture size.

### Can I run umans-gate in production?

umans-gate is a personal-use project with no production support tier, no SLA, and no backward-compatibility commitment. It is designed for local development and debugging. Security vulnerabilities are the exception. See [SECURITY.md](SECURITY.md) for the 48-hour acknowledgment SLA.

### How do I secure the dashboard?

Set `DASHBOARD_TOKEN` via env or config. When set, all `/dashboard/api/*` routes, `/health`, `/metrics`, and WebSocket connections require `Authorization: Bearer <token>` (or `?token=<token>` for WS). Includes brute-force protection.

### Does umans-gate support HTTP/2?

Yes, as an opt-in. Set `UPSTREAM_PROTOCOL=http2` in config or env. HTTP/1.1 is the default because benchmarks show no measurable difference at typical LLM concurrency levels (4 concurrent SSE streams). See [BENCHMARKS.md](docs/BENCHMARKS.md) for details.

### What is vision handoff and when should I use it?

Vision handoff replaces image blocks in requests with text descriptions generated by a vision model (default `umans-flash`). This reduces token cost and enables text-only models to process image-bearing requests. Descriptions are cached for 7 days. Use `VISION_STRATEGY=always` to intercept all images, `catalog` (default) to intercept only when the target model lacks vision capability, or `never` to disable.

## Documentation

**Start here:** [Documentation Index](docs/README.md): curated reading guide

**Understand:**
- [Architecture](docs/ARCHITECTURE.md): system design and data flow
- [Proxy Modifications](docs/proxy-modifications.md): proxy modification inventory

**Operate:**
- [Operations](docs/OPERATIONS.md): day-to-day ops: start/stop, upgrades, health, backup
- [Troubleshooting](docs/TROUBLESHOOTING.md): common issues
- [Benchmarks](docs/BENCHMARKS.md): benchmark results

**Develop:**
- [Contributing](CONTRIBUTING.md): how to contribute
- [Security Policy](SECURITY.md): vulnerability reporting
- [Changelog](CHANGELOG.md): version history

**Design:**
- [Dashboard Design System](dashboard/DESIGN.md): design tokens and components

## License

MIT. See [LICENSE](LICENSE). This project provides [llms.txt](./llms.txt) for LLM discoverability.
