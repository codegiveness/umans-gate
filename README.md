# umans-gate — Capture proxy for LLM APIs

[![npm version](https://img.shields.io/npm/v/umans-gate.svg)](https://www.npmjs.com/package/umans-gate)
[![npm downloads](https://img.shields.io/npm/dm/umans-gate.svg)](https://www.npmjs.com/package/umans-gate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/codegiveness/umans-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/codegiveness/umans-gate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/codegiveness/umans-gate/actions/workflows/codeql.yml/badge.svg)](https://github.com/codegiveness/umans-gate/actions/workflows/codeql.yml)

> A capture proxy for LLM APIs. Point your harness at it, and every
> request/response is stored in SQLite with a live inspection dashboard.
>
> **Personal-use project.** Not affiliated with, endorsed by, or an
> official product of Umans.

**Setup in 30 seconds.**

```bash
npx umans-gate
```

The proxy starts on `http://localhost:1945`; the dashboard opens at
`http://localhost:1945/dashboard/`. Point any Anthropic or OpenAI-compatible
harness at the proxy URL — every request and response is captured.

## Who This Is For

- **Claude Code users** who want to see what's actually on the wire — TTL
  stamping, cache hits, thinking blocks — in real time.
- **Prompt engineers** debugging cache_control TTL, reasoning effort, and
  vision handoff against Anthropic or OpenAI-compatible APIs.
- **Developers** who need traffic inspection, concurrency gating, and
  rate-limit validation without modifying their LLM harness.

## What It Does

| Feature | Description |
|---------|-------------|
| **Capture proxy** | Intercepts LLM API traffic (Anthropic + OpenAI-compatible), stores in SQLite with optional zstd compression |
| **Stamp pipeline** | Applies TTL, `top_k`, `max_tokens`, `thinking`, `output_config`, `context_management`, `temperature` stamps — two toggles (Anthropic / OpenAI) |
| **Vision handoff** | Replaces image blocks with text descriptions from a vision model; cached 7 days with persistent SQLite storage |
| **Concurrency gate** | Semaphore + circuit breaker with intention-based reservations, hard cap, soft limit from `/v1/usage`, queue timeout |
| **Rate limiting** | Sliding-window weighted rate limiter, auto-derived from `/v1/usage` or explicit |
| **Connection warmer** | Periodic `/v1/models` pings keep TLS warm; skips when real traffic occurred recently |
| **Usage tracking** | Fetches `/v1/usage` to size concurrency, detect rate-boxing, manage priority demotion |
| **Live inspector** | React + shadcn/ui dashboard with WebSocket live updates |
| **SSE rendering** | Streaming responses captured and rendered with expandable event previews |
| **Ring buffer storage** | Last N captures (default 200) in WAL-mode SQLite |
| **Write-behind queue** | Batched DB writes to minimize blocking during streaming |
| **Hop-by-hop header stripping** | Correct HTTP proxy behavior |
| **Protocol flexibility** | Upstream HTTP/1.1 (default) or HTTP/2 |

## Important Notes

1. **The proxy modifies your requests.** When stamping is enabled
   (`STAMP_CLAUDE_CODE_ENABLED` or `STAMP_REASONING_EFFORT_ENABLED`), the
   proxy rewrites request bodies before forwarding upstream. The stamped
   body is what gets sent upstream AND captured. The proxy also forces
   `accept-encoding: identity` and strips `content-encoding` unconditionally.
2. **Vision strategy and non-Claude Code harnesses.** When
   `VISION_STRATEGY` is `never` — or a vision-capable model under `catalog`
   — images pass through untouched. Do NOT configure the model as
   vision-capable on the harness side (except Claude Code). The default
   `catalog` strategy runs in **background mode**: on a cache miss, the
   original image-bearing body is forwarded immediately; vision processing
   populates the cache for the *next* request.
3. **Upstream target is hardcoded.** Forwards to
   `https://api.code.umans.ai`. OpenAI chat path, warmer path, and vision
   target are also hardcoded — not configurable. Listen address is hardcoded
   to `127.0.0.1` (loopback only).
4. **Ring buffer overwrites old captures.** Keeps only the last N (default
   `MAX_CAPTURES=200`). Increase in config for longer history.
5. **API key unlocks key features.** Without `UMANS_API_KEY`, the proxy
   still captures traffic, but `/v1/usage` polling, concurrency gate sizing,
   rate-limit validation, and vision handoff stay disabled.
6. **Foreground by default.** `umans-gate` won't survive reboots. Run
   `umans-gate service install` to register as a managed service.
7. **Default concurrency and the hard cap toggle.** `CONCURRENCY_HARD_CAP`
   defaults to `16`, `CONCURRENCY_SOFT_LIMIT` to `8`. By default
   (`USE_HARD_CAP=false`), the effective limit is the soft limit. Both are
   auto-sized from `/v1/usage` when `UMANS_API_KEY` is set. Toggle in the
   dashboard Config tab — no restart needed.

## Usage Rights

**Personal-use project** with architecture modeled on production patterns
but single-maintainer support. Source published under MIT for transparency
and educational purposes. No guaranteed response time. No
backward-compatibility commitment across versions — config shapes, flags,
and APIs may change between releases without a deprecation cycle. No
production support tier, no SLA. Security vulnerabilities are the one
exception: see [SECURITY.md](SECURITY.md) for the 48-hour acknowledgment
SLA on confirmed reports.

**Not an official Umans product.** Not affiliated with, endorsed by, or
supported by Umans AI. All upstream service names, model names, and API
endpoints belong to their respective owners.

## Install

**npm (recommended):** `npm install -g umans-gate && umans-gate`

**npx (no install):** `npx umans-gate`

**Bun (for developers):**

```bash
git clone https://github.com/codegiveness/umans-gate.git
cd umans-gate && bun install && bun src/cli.ts
```

> No prerequisites for npm/npx — the package bundles a pre-compiled binary.
> For development, [Bun](https://bun.sh) ≥ 1.1.0 is required.

### Platform Support

| OS | Arch | npm Package |
|----|------|-------------|
| macOS | arm64/x64 | `umans-gate-darwin-{arm64,x64}` |
| Linux | x64/arm64 | `umans-gate-linux-{x64,arm64}` |
| Windows | x64/arm64 | `umans-gate-win32-{x64,arm64}` |

## Quick Start

1. **Start the proxy:** `umans-gate`
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

5. **Secure the dashboard** (optional): `export DASHBOARD_TOKEN=your-secret-token`
   — when set, all `/dashboard/api/*` routes, `/health`, and `/metrics`
   require `Authorization: Bearer <token>`. WebSocket requires
   `?token=<token>`. Includes brute-force protection.

6. **Make it survive reboots** (optional): `umans-gate service install`

## Updating

```bash
umans-gate update          # self-update (npm global or standalone binary)
umans-gate update --check # check without installing
umans-gate uninstall      # removes service, config, database, binary
```

The updater detects install method and acts accordingly. If running as a
managed service, stops before update and restarts after. Pass `--keep-config`
to preserve `config.json` and the database.

## Service Persistence

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

## Configuration

> **Dashboard-first:** Edit config via the **Config** tab at
> `http://localhost:1945/dashboard/`. The dashboard validates, shows field
> descriptions, and can hot-reload or restart.

Config loads from a JSON file with env var overrides. On first run,
`loadConfig()` writes defaults if the file doesn't exist; existing configs
are never overwritten. All env vars have `snake_case` JSON equivalents.

| OS | Path |
|----|------|
| Linux/macOS | `$XDG_CONFIG_HOME/umans-gate/config.json` or `~/.config/umans-gate/config.json` |
| Windows | `%APPDATA%/umans-gate/config.json` |

**Precedence:** env vars > JSON config > built-in defaults.

### Key config fields

| Variable | Default | Description |
|---|---|---|
| `PORT` | `1945` | Listen port |
| `MAX_CAPTURES` | `200` | Ring buffer size |
| `DB_PATH` | `./umans-gate.db` | SQLite database path |
| `UPSTREAM_PROTOCOL` | `http1.1` | `http1.1` or `http2` |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Upstream fetch timeout (5 min) |
| `STAMP_CLAUDE_CODE_ENABLED` | `false` | Toggle Claude Code stamp bundle (Anthropic) |
| `STAMP_REASONING_EFFORT_ENABLED` | `false` | Toggle `reasoning_effort` stamping (OpenAI) |
| `UMANS_API_KEY` | _(empty)_ | Unlocks `/v1/usage`, gate sizing, rate-limit, vision |
| `DASHBOARD_TOKEN` | _(empty)_ | Secures dashboard + `/health` + `/metrics` + WS |
| `CONCURRENCY_HARD_CAP` | `16` | Max concurrent upstream (auto from `/v1/usage`) |
| `CONCURRENCY_SOFT_LIMIT` | `8` | Soft limit (auto from `/v1/usage`) |
| `USE_HARD_CAP` | `false` | `true` = use hard cap; `false` = use soft limit |
| `VISION_STRATEGY` | `catalog` | `never`, `catalog`, or `always` |
| `VISION_MODEL` | `umans-flash` | Vision model for image description |
| `BREAKER_THRESHOLD` | `5` | Circuit breaker failure threshold |
| `RATE_LIMIT_REQUESTS` | `0` | `0` = auto, `-1` = unlimited, `N` = explicit |

See [AGENTS.md](AGENTS.md) for the complete config field table.

### Hot reload

The Config tab can save and hot-reload via
`POST /dashboard/api/config/reload`. Hot-reloadable: `stamp_claude_code_enabled`,
`breaker_*`, `rate_limit_*`, `usage_*` (`usage_history_enabled`,
`usage_raw_retention_days`, `usage_gap_threshold_minutes`,
`usage_idle_session_timeout_minutes`), `incident_retention_days`, and the 7 intent-aware vision fields
(`vision_intent_strategy`, `vision_decomposition_enabled`,
`vision_decomposition_timeout_ms`, `vision_crafting_timeout_ms`,
`vision_adjacent_text_max_chars`, `vision_recent_messages_count`,
`vision_system_prompt_max_chars`). Fields marked `restartRequired` (e.g.
`port`, `db_path`, `upstream_protocol`) require a server restart.

### Stamp pipeline

When `STAMP_CLAUDE_CODE_ENABLED` is on, applies to Anthropic requests:
TTL (`"1h"` on `cache_control` ephemeral), `top_k` (20), `temperature`
(1.0), `max_tokens` (131071 for `umans-glm*`, 32767 others), `thinking`
(`{ "type": "adaptive" }`), `output_config` (effort high/max),
`context_management` (clear_thinking). For OpenAI-compatible,
`STAMP_REASONING_EFFORT_ENABLED` injects `reasoning_effort` and removes
`max_tokens`/`thinking`.

### Vision handoff

Replaces image blocks with text descriptions from a vision model.
Strategies: `catalog` (default, only if model lacks vision), `always`,
`never`. Intent-aware prompting (`VISION_INTENT_STRATEGY`, default `auto`):
`generic`, `slotted`, `crafted`, `decomposed`. Vision calls are serialized
by the concurrency gate (default concurrency=1).

### Concurrency gate

Semaphore (soft limit + hard cap) + circuit breaker (opens after
`breaker_threshold` 429s in `breaker_window_ms`, blocks for
`breaker_cooldown_ms`, then half-opens) + intention-based reservations +
queue (`max_queue_depth`, `queue_timeout_ms`).

### Rate limiting

`rate_limit_requests: 0` = auto from `/v1/usage`; `-1` = unlimited; `N` =
explicit weighted sliding window. Window size derived from `/v1/usage`.

## Programmatic API

```typescript
import { createProxyServer } from "umans-gate";

const server = createProxyServer({
  config: { port: 8080 },
});

// server.db     — CaptureDB instance
// server.ws     — WsBroadcaster instance
// server.queue  — WriteQueue instance
// server.shutdown() — graceful shutdown
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

## Documentation

**Start here:** [Documentation Index](docs/README.md) — curated reading guide

**Understand:**
- [Architecture](docs/ARCHITECTURE.md) — system design and data flow
- [Proxy Modifications](docs/proxy-modifications.md) — proxy modification inventory

**Operate:**
- [Operations](docs/OPERATIONS.md) — day-to-day ops: start/stop, upgrades, health, backup
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common issues
- [Benchmarks](docs/BENCHMARKS.md) — benchmark results

**Develop:**
- [Contributing](CONTRIBUTING.md) — how to contribute
- [Security Policy](SECURITY.md) — vulnerability reporting
- [Changelog](CHANGELOG.md) — version history

**Design:**
- [Dashboard Design System](dashboard/DESIGN.md) — design tokens and components

## License

MIT — see [LICENSE](LICENSE). This project provides [llms.txt](./llms.txt) for LLM discoverability.
