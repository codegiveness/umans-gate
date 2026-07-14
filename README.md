# umans-gate

[![npm version](https://img.shields.io/npm/v/umans-gate.svg)](https://www.npmjs.com/package/umans-gate)
[![npm downloads](https://img.shields.io/npm/dm/umans-gate.svg)](https://www.npmjs.com/package/umans-gate)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/codegiveness/umans-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/codegiveness/umans-gate/actions/workflows/ci.yml)
[![CodeQL](https://github.com/codegiveness/umans-gate/actions/workflows/codeql.yml/badge.svg)](https://github.com/codegiveness/umans-gate/actions/workflows/codeql.yml)

> A capture proxy for LLM APIs. Point your harness at it, and every
> request/response is stored in SQLite with a live inspection dashboard.
> Built for the [umans-open-stack](https://github.com/umans-ai/umans-open-stack)
> community.

**Setup in 30 seconds. Set it and forget it.**

```bash
npx umans-gate
```

That's it. The proxy starts on `http://localhost:1945` and the inspector
dashboard opens at `http://localhost:1945/dashboard/`. Point any
Anthropic or OpenAI-compatible harness at the proxy URL — every
request and response is captured automatically.

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [Updating](#updating)
- [Configuration](#configuration)
  - [Config Fields](#config-fields)
  - [Hot Reload and Restart](#hot-reload-and-restart)
  - [Stamp Pipeline](#stamp-pipeline)
  - [Vision Handoff](#vision-handoff)
  - [Concurrency Gate](#concurrency-gate)
  - [Rate Limiting](#rate-limiting)
- [Programmatic API](#programmatic-api)
- [Inspector Dashboard](#inspector-dashboard)
- [Development](#development)
- [Project Structure](#project-structure)
- [Documentation](#documentation)
- [Related Projects](#related-projects)
- [Contributing](#contributing)
- [License](#license)

## Install

**npm (recommended for end users):**

```bash
npm install -g umans-gate
umans-gate
```

**npx (no install, run once):**

```bash
npx umans-gate
```

**Bun (for developers):**

```bash
git clone https://github.com/codegiveness/umans-gate.git
cd umans-gate
bun install
bun src/cli.ts
```

> **No prerequisites for npm/npx.** The npm package bundles a pre-compiled
> standalone binary for your platform. For development from source,
> [Bun](https://bun.sh) ≥ 1.1.0 is required.

### Platform Support

Pre-compiled binaries are published for:

| OS | Architecture | npm Package |
|----|-------------|-------------|
| macOS | arm64 (Apple Silicon) | `umans-gate-darwin-arm64` |
| macOS | x64 (Intel) | `umans-gate-darwin-x64` |
| Linux | x64 | `umans-gate-linux-x64` |
| Linux | arm64 | `umans-gate-linux-arm64` |
| Windows | x64 | `umans-gate-win32-x64` |
| Windows | arm64 | `umans-gate-win32-arm64` |

The main `umans-gate` package automatically detects your platform and
installs the correct binary.

## Quick Start

1. **Start the proxy:**

   ```bash
   umans-gate
   ```

2. **Point your harness** to `http://localhost:1945` as the base URL:

   ```bash
   # Anthropic API
   export ANTHROPIC_BASE_URL=http://localhost:1945

   # OpenAI-compatible API
   export OPENAI_BASE_URL=http://localhost:1945
   ```

3. **Open the inspector dashboard** at `http://localhost:1945/dashboard/`

   Every request and response is captured to SQLite with live WebSocket
   updates. The dashboard shows full request/response bodies, streaming
   SSE events, timing, token economics, and more.

4. **Set your API key** (optional but recommended):

   ```bash
   # Option A: environment variable
   export UMANS_API_KEY=your-key-here

   # Option B: config.json (persists across restarts)
   umans-gate config show    # see current config + file path
   # Edit config.json and set "umans_api_key"
   # Or use the dashboard Config tab at /dashboard/
   ```

   Setting `UMANS_API_KEY` enables `/v1/usage` polling, concurrency gate
   sizing, rate-limit validation, and vision handoff.

### What It Does

| Feature | Description |
|---------|-------------|
| **Capture proxy** | Intercepts all LLM API traffic (Anthropic, OpenAI-compatible) and stores it in SQLite with optional zstd compression |
| **Stamp pipeline** | Applies TTL, `top_k`, `max_tokens`, `thinking`, `output_config`, `context_management`, and `temperature` stamps — toggled by a single switch |
| **Vision handoff** | Replaces image blocks with text descriptions from a vision model, enabling text-only models to "see" images. Descriptions are cached (7-day TTL) with persistent SQLite storage |
| **Concurrency gate** | Semaphore + circuit breaker with intention-based reservations, hard cap, soft limit driven by `/v1/usage`, queue timeout, and over-subscription fallback |
| **Rate limiting** | Sliding-window weighted rate limiter for pro-tier request limits, auto-derived from `/v1/usage` or explicitly configured |
| **Connection warmer** | Periodic `/v1/models` pings keep TLS warm, skipping when real traffic occurred recently |
| **Usage tracking** | Fetches and reconciles `/v1/usage` to size concurrency limits, detect rate-boxing, and manage priority demotion |
| **Live inspector** | React + shadcn/ui dashboard with WebSocket live updates |
| **SSE rendering** | Streaming responses are captured and rendered with expandable event previews |
| **Ring buffer storage** | Keeps the last N captures (default 200) with WAL mode SQLite |
| **Write-behind queue** | Batched database writes to minimize blocking during streaming |
| **Worker-based capture** | Offloads capture writes to a worker thread for non-blocking streaming |
| **Hop-by-hop header stripping** | Correct HTTP proxy behavior |
| **Protocol flexibility** | Configurable upstream HTTP/1.1 (default) or HTTP/2 |

## Updating

```bash
umans-gate update     # self-update (npm global or standalone binary)
```

The updater detects your install method (npm global, standalone
executable, or dev) and performs the appropriate action. For npm global
installs, it runs `npm update -g umans-gate`. For standalone binaries,
it points you to the latest GitHub Release.

To check for updates without installing:

```bash
umans-gate update --check
```

### Uninstall

```bash
umans-gate uninstall   # removes config, database, and binary
```

Or manually:

```bash
npm uninstall -g umans-gate
rm -rf ~/.config/umans-gate
```

## Configuration

> **Dashboard-first:** The recommended way to change configuration is via
> the **Config** tab in the dashboard at `http://localhost:1945/dashboard/`.
> Editing `config.json` directly works, but the dashboard validates against
> the upstream `/v1/usage` hard cap, shows field descriptions, and can
> hot-reload or restart the server for you. If you do edit the file,
> restart the server afterward (the dashboard auto-reloads on save).

Configuration is loaded from a JSON file with environment variable overrides.

**Config file path** (auto-created on first run):

| OS | Path |
|----|------|
| Linux/macOS | `$XDG_CONFIG_HOME/umans-gate/config.json` or `~/.config/umans-gate/config.json` |
| Windows | `%APPDATA%/umans-gate/config.json` |

**Precedence**: environment variables > JSON config file > built-in defaults.

On first run, `loadConfig()` writes a `config.json` with defaults to the
resolved path if it does not already exist. Existing configs are never
overwritten.

All configuration variables have JSON equivalents using `snake_case`
(e.g., `UPSTREAM_PROTOCOL` → `upstream_protocol` in `config.json`).

### Config Fields

| Variable | Default | Description |
|---|---|---|
| `PORT` | `1945` | Listen port |
| `MAX_CAPTURES` | `200` | Ring buffer size (keeps last N) |
| `DB_PATH` | `./umans-gate.db` | SQLite database path |
| `IDLE_TIMEOUT` | `255` | Bun.serve idleTimeout — HTTP connection idle timeout in seconds (1–255) |
| `UPSTREAM_PROTOCOL` | `http1.1` | Upstream protocol: `http1.1` or `http2` |
| `UPSTREAM_TIMEOUT_MS` | `300000` | Upstream fetch timeout in ms (5 min) |
| `STAMP_CLAUDE_CODE_ENABLED` | `false` | Toggle full Claude Code stamp bundle (TTL, `top_k`, `max_tokens`, `thinking`, `output_config`, `context_management`, `temperature`) |
| `STAMP_REASONING_EFFORT_ENABLED` | `false` | Toggle OpenAI-compatible `reasoning_effort` stamping (`high`, `max` for `umans-glm*`; removes `max_tokens`/`thinking`) |
| `WARMER_ENABLED` | `true` | Toggle TLS connection warmer |
| `WARMER_INTERVAL_MS` | `20000` | Warmer ping interval in ms |
| `UMANS_API_KEY` | _(empty)_ | Required for `/v1/usage` fetch, concurrency gate sizing, and rate-limit validation |
| `USAGE_REFRESH_MS` | `60000` | `/v1/usage` poll interval in ms |
| `MODELS_REFRESH_MS` | `3600000` | `/v1/models` poll interval in ms |
| `CONCURRENCY_HARD_CAP` | `1` | Maximum concurrent upstream requests (hard ceiling) |
| `CONCURRENCY_SOFT_LIMIT` | `1` | Soft limit (driven by `/v1/usage`, adjustable at runtime) |
| `CONCURRENCY_MAIN_RESERVATION` | `1` | Reserved slots for main requests |
| `CONCURRENCY_VISION_RESERVATION` | `1` | Reserved slots for vision requests |
| `RATE_LIMIT_REQUESTS` | `0` | Pro-tier rolling-window limit. `-1` = unlimited, `0` = auto-derive from `/v1/usage`, `>0` = explicit |
| `QUEUE_TIMEOUT_MS` | `30000` | Max wait time for queued permits |
| `MAX_QUEUE_DEPTH` | `256` | Max queued permits |
| `RELEASE_COOLDOWN_MS` | `1000` | Cooldown after releasing a permit |
| `BREAKER_THRESHOLD` | `5` | Circuit breaker failure threshold |
| `BREAKER_WINDOW_MS` | `300000` | Circuit breaker failure window (5 min) |
| `BREAKER_COOLDOWN_MS` | `60000` | Circuit breaker cooldown (1 min) |
| `VISION_STRATEGY` | `catalog` | When to intercept images: `never`, `catalog` (only if model lacks vision), `always` |
| `VISION_MODEL` | `umans-flash` | Vision model used for image description |
| `VISION_MAX_IMAGES` | `5` | Max images processed per request |
| `VISION_MAX_DESCRIPTION_TOKENS` | `4096` | Max tokens for vision descriptions |
| `VISION_CONCURRENCY` | `1` | Vision model call concurrency |
| `VISION_MAX_DIMENSION` | `2048` | Max image dimension before resize |
| `VISION_JPEG_QUALITY` | `92` | JPEG compression quality |
| `VISION_IMAGE_FORMAT` | `png` | Image format sent to vision model: `jpeg` or `png` |
| `VISION_CACHE_SIZE` | `1000` | In-memory description cache size |
| `VISION_CACHE_TTL_MS` | `604800000` | Description cache TTL (7 days) |
| `VISION_PERSISTENT_CACHE` | `true` | Persist vision descriptions to SQLite |
| `VISION_TIMEOUT_MS` | `0` | Vision call timeout (0 = no timeout) |
| `CAPTURE_BODY_MAX_BYTES` | `10000000` | Max captured request/response body size (10 MB, 0 = unlimited) |
| `COMPRESSION_ENABLED` | `true` | zstd compression for stored bodies |
| `QUEUE_MAX_DEPTH` | `100` | Max write-behind response queue depth |
| `WS_BACKPRESSURE_LIMIT` | `1048576` | WebSocket backpressure limit in bytes (1 MB) |
| `WS_CLOSE_ON_BACKPRESSURE_LIMIT` | `true` | Close WebSocket connections exceeding backpressure limit |

The upstream target (`https://api.code.umans.ai`), OpenAI chat path
(`chat/completions`), warmer path (`/v1/models`), and vision target are
hardcoded — not configurable.

### Hot Reload and Restart

The dashboard's Config tab can save changes and trigger a hot reload
via `POST /dashboard/api/config/reload`. Hot-reloadable fields (e.g.
`stamp_claude_code_enabled`, `breaker_*`, `rate_limit_*`)
apply live; fields marked `restartRequired` (e.g. `port`, `db_path`,
`upstream_protocol`, `vision_*`) require a server restart.

The dashboard also has a **Restart** button (`POST /dashboard/api/restart`)
that calls `process.exit(0)`. This requires an external process manager
to restart the server automatically:

| Manager | Command |
|---------|---------|
| `bun --watch` | `bun --watch src/cli.ts` |
| systemd | `Restart=always` in the unit file |
| pm2 | `pm2 start src/cli.ts --interpreter bun --watch` |

Without a process manager, the server exits and stays down until you
start it manually.

### Stamp Pipeline

When `STAMP_CLAUDE_CODE_ENABLED` is on, the proxy applies the full Claude
Code stamp bundle to Anthropic requests:

1. **TTL stamping**: adds `"ttl": "1h"` to every `cache_control: {type:"ephemeral"}` block
2. **`top_k` injection**: injects `"top_k": 20` after the `model` field
3. **`temperature` stamping**: forces `temperature: 1.0`
4. **`max_tokens` stamping**: `131071` for `umans-glm*` models, `32767` for others
5. **`thinking` injection**: `{ "type": "adaptive" }` for `umans-coder`, `umans-flash`, `umans-kimi*`, `umans-qwen*`
6. **`output_config` injection**: `{ "effort": "high" }` for most models, `{ "effort": "max" }` for `umans-glm*`
7. **`context_management` injection**: `{ "edits": [{ "type": "clear_thinking_20251015", "keep": "all" }] }`

For OpenAI-compatible requests, `STAMP_REASONING_EFFORT_ENABLED` injects
`"reasoning_effort": "high"` (or `"max"` for `umans-glm*`) and removes
`max_tokens`/`thinking` from the body.

The stamped body is what gets forwarded upstream AND what gets captured — so
the inspector shows exactly what went to the API.

### Vision Handoff

The vision handoff pipeline replaces image blocks in the request body with text
descriptions generated by a vision model:

1. Detects image blocks in Anthropic and OpenAI request bodies
2. Transcodes images to the configured format (PNG/JPEG) with max dimension
3. Sends to the vision model (`umans-flash`) with a detailed OCR prompt
4. Caches descriptions in-memory (1000 entries) and persistently in SQLite
5. Replaces image blocks with text descriptions

Strategies:
- `catalog` (default): intercept only if the model is known to lack vision support
- `always`: intercept all images regardless of model
- `never`: disabled

Vision calls are serialized by the concurrency gate (default concurrency=1)
because the upstream has limited vision slots.

### Concurrency Gate

The concurrency gate (`src/limiter/`) prevents overwhelming the upstream:

- **Semaphore**: enforces a soft limit (driven by `/v1/usage`) and hard cap
- **Circuit breaker**: opens after `breaker_threshold` 429s in `breaker_window_ms`,
  blocks traffic for `breaker_cooldown_ms`, then half-opens to test
- **Intention-based reservations**: main and vision requests have reserved slots
- **Queue**: over-limit requests are queued up to `max_queue_depth` with
  `queue_timeout_ms` timeout
- **Over-subscription fallback**: when reservations exceed capacity, permits
  are still granted if actual usage allows

### Rate Limiting

The sliding-window rate limiter (`src/rate.ts`) enforces pro-tier request limits:

- `rate_limit_requests: 0` — auto-derive from `/v1/usage` (default)
- `rate_limit_requests: -1` — unlimited (no limiter)
- `rate_limit_requests: N` — explicit limit with weighted sliding window

The window size is derived from `/v1/usage` and is not configurable.

## Programmatic API

```typescript
import { createProxyServer } from "umans-gate";

const server = createProxyServer({
  config: { port: 8080 },
});

// server.db  — CaptureDB instance
// server.ws  — WsBroadcaster instance
// server.queue — WriteQueue instance
// server.shutdown() — graceful shutdown
```

## Inspector Dashboard

The dashboard is a Vite + React + TypeScript + Tailwind + shadcn/ui app in `dashboard/`.

```bash
cd dashboard
bun install
bun run dev    # dev server at localhost:5173
bun run build  # production build to dashboard/dist/
```

The dashboard connects to:
- `GET /dashboard/api/captures` — capture list
- `GET /dashboard/api/captures/:id` — full capture detail
- `POST /dashboard/api/clear` — clear all captures
- `WS /dashboard/ws` — live updates (`new`, `update`, `clear` messages)

## Development

```bash
bun run dev             # start proxy server
bun run typecheck       # TypeScript checking
bun run lint            # Biome lint
bun run lint:fix        # Biome lint + auto-fix
bun run test            # run server tests
bun run test:dashboard  # run dashboard tests (vitest + jsdom)
bun run test:all        # run server + dashboard tests
bun run build           # build server (tsup) + dashboard (vite)
```

## Project Structure

```
umans-gate/
├── src/
│   ├── cli.ts                    # CLI entry point
│   ├── index.ts                  # createProxyServer() factory + exports
│   ├── config.ts                 # env-driven configuration
│   ├── db.ts                     # SQLite capture store (WAL, ring buffer)
│   ├── proxy.ts                  # proxy handler (capture + stamping + streaming)
│   ├── stamp.ts                  # cache_control TTL stamping logic
│   ├── stamp-pipeline.ts         # unified stamp orchestrator
│   ├── stamp-temperature.ts      # temperature stamping
│   ├── stamp-thinking.ts         # thinking / max_tokens / output_config stamping
│   ├── stamp-topk.ts             # top_k injection
│   ├── stamp-reasoning.ts        # OpenAI reasoning_effort stamping
│   ├── viewer.ts                 # inspector dashboard + REST API router
│   ├── ws.ts                     # WebSocket broadcast manager
│   ├── queue.ts                  # write-behind batched flush queue
│   ├── rate.ts                   # sliding-window rate limiter
│   ├── warmer.ts                 # TLS connection warmer
│   ├── metrics.ts                # aggregated runtime statistics
│   ├── economics.ts              # token cost calculation
│   ├── usage.ts                  # /v1/usage fetch + reconciliation
│   ├── usage-extract.ts          # usage extraction (Anthropic + OpenAI)
│   ├── model-info-parser.ts      # /v1/models response parser
│   ├── model-policy.ts           # model-aware stamping decisions
│   ├── compress.ts               # zstd body compression
│   ├── vision-description-store.ts  # persistent vision description storage
│   ├── updater.ts                # self-update logic
│   ├── helpers.ts                # shared utilities
│   ├── logger.ts                  # structured scoped logging
│   ├── banner.ts                 # startup banner
│   ├── types.ts                  # shared types
│   ├── limiter/
│   │   ├── gate.ts               # ConcurrencyGate (Semaphore + CircuitBreaker)
│   │   ├── circuit-breaker.ts    # CircuitBreaker implementation
│   │   ├── types.ts              # gate option types
│   │   └── index.ts              # re-exports
│   ├── vision/
│   │   ├── handoff.ts            # vision handoff orchestrator
│   │   ├── detect.ts             # image block detection
│   │   ├── cache.ts              # in-memory description cache
│   │   ├── persistent-cache.ts   # SQLite-backed description cache
│   │   ├── transcode.ts          # image transcoding
│   │   ├── wrapper.ts            # description wrapper + policy
│   │   └── sink.ts               # vision record sink
│   ├── workers/                  # worker-based capture pipeline
│   └── shared/                   # extracted domain helpers
├── dashboard/                    # React + shadcn/ui dashboard
├── test/                         # bun:test test suite
├── docs/                         # additional documentation
│   ├── ARCHITECTURE.md           # system architecture
│   ├── TROUBLESHOOTING.md         # troubleshooting guide
│   ├── BENCHMARKS.md             # benchmark results
│   ├── PRODUCT.md                # product positioning and users
│   └── proxy-modifications.md    # proxy modification inventory
├── benchmark/                    # benchmark scripts
├── .github/                      # issue templates, workflows, PR template
└── dist/                         # build output (gitignored)
```

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system design and data flow
- [Proxy Modifications](docs/proxy-modifications.md) — complete inventory of proxy modifications
- [Troubleshooting](docs/TROUBLESHOOTING.md) — common issues and solutions
- [Benchmarks](docs/BENCHMARKS.md) — benchmark methodology and results
- [Product](docs/PRODUCT.md) — product positioning and target users
- [Dashboard Design System](dashboard/DESIGN.md) — design system documentation
- [Changelog](CHANGELOG.md) — version history
- [Contributing](CONTRIBUTING.md) — how to contribute
- [Roadmap](ROADMAP.md) — future plans
- [Security Policy](SECURITY.md) — vulnerability reporting and security practices

## Related Projects

- **[umans-open-stack](https://github.com/umans-ai/umans-open-stack)** — A
  curated set of open source playbooks and tools tested with Umans. umans-gate
  implements several patterns documented there: concurrency gating, vision
  handoff, cache_control TTL stamping, and workflow orchestration. If you're
  using umans-gate, the open-stack playbooks explain the why behind each
  feature.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup, code style,
testing, and release instructions.

## License

MIT
