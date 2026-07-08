# umans-gate

> **Disclaimer:** This is a community project. The author is not an official
> Umans developer — just a contributor building tools around the Umans API.
> "umans" and related marks belong to their respective owners.

LLM capture proxy with Anthropic cache_control TTL stamping and a live inspection dashboard.

Point your LLM harness at `http://localhost:9000`, and every request/response is captured to SQLite with a live WebSocket-updating inspector UI at `http://localhost:9000/dashboard/`.

## Features

- **Capture proxy**: intercepts all LLM API traffic (Anthropic, OpenAI-compatible) and stores it in SQLite
- **Anthropic cache_control TTL stamping**: automatically stamps `ttl` onto `cache_control: {type:"ephemeral"}` blocks before forwarding — so ephemeral cache entries get a default TTL without client changes
- **Live inspector dashboard**: React + shadcn/ui dashboard with WebSocket live updates
- **SSE rendering**: streaming responses are captured and rendered with expandable event previews
- **Ring buffer storage**: keeps the last N captures (default 200) with WAL mode SQLite
- **Write-behind queue**: batched database writes to minimize blocking during streaming
- **Hop-by-hop header stripping**: correct HTTP proxy behavior
- **Protocol flexibility**: configurable upstream HTTP/1.1 (default) or HTTP/2

## Quick start

```bash
# Install
bun install

# Start the proxy (reads config.json + env overrides)
bun src/cli.ts

# Or after build:
bun run build
./dist/cli.js
```

Point your harness base URL to `http://localhost:9000` and open the inspector at `http://localhost:9000/dashboard/`.

## Configuration

> **⚠️ Dashboard-first:** The recommended way to change configuration is via
> the **Config** tab in the dashboard at `http://localhost:9000/dashboard/`.
> Editing `config.json` directly works, but the dashboard validates against
> the upstream `/v1/usage` hard cap, shows field descriptions, and can hot-reload
> or restart the server for you. If you do edit the file, restart the server
> afterward (or use the dashboard's **Reload from Disk** button).

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

All env vars from `.env.example` have JSON equivalents using `snake_case`
(e.g., `UPSTREAM_PROTOCOL` → `upstream_protocol`).

### Migration from YAML

If a legacy `config.yml` exists and no `config.json` is present,
`migrateFromYamlIfNeeded()` parses the YAML and writes a `config.json`
with the same values. The YAML file is not deleted.

### Hot reload and restart

The dashboard's Config tab can save changes and trigger a hot reload
via `POST /dashboard/api/config/reload`. Hot-reloadable fields (e.g.
`stamp_cache_ttl_enabled`, `breaker_*`, `rate_limit_*`) apply live;
fields marked `restartRequired` (e.g. `port`, `host`, `db_path`,
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

### Config fields

| Variable | Default | Description |
|---|---|---|
| `PORT` | `9000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `MAX_CAPTURES` | `200` | Ring buffer size (keeps last N) |
| `DB_PATH` | `./umans-gate.db` | SQLite database path |
| `IDLE_TIMEOUT` | `255` | Bun.serve idleTimeout — HTTP connection idle timeout in seconds (1–255) |
| `UPSTREAM_PROTOCOL` | `http1.1` | Upstream protocol: `http1.1` or `http2` |
| `STAMP_CACHE_TTL_ENABLED` | `false` | **Experimental.** Toggle Anthropic `cache_control` TTL stamping (`1h` when on) |
| `STAMP_TOP_K_ENABLED` | `false` | **Experimental.** Toggle Anthropic `top_k` stamping (`20` when on) |
| `STAMP_MAX_TOKENS_ENABLED` | `false` | **Experimental.** Toggle Anthropic `max_tokens` stamping (`32000` when on, all models) |
| `STAMP_THINKING_ENABLED` | `false` | **Experimental.** Toggle Anthropic `thinking` stamping for `umans-coder`, `umans-flash`, `umans-kimi*`, `umans-qwen*` models |
| `STAMP_OUTPUT_CONFIG_ENABLED` | `false` | **Experimental.** Toggle Anthropic `output_config` stamping (`effort: "high"`, `effort: "max"` for `umans-glm*`) |
| `STAMP_REASONING_EFFORT_ENABLED` | `false` | **Experimental.** Toggle OpenAI-compatible `reasoning_effort` stamping (`high`, `max` for `umans-glm*`; removes `max_tokens`/`thinking`) |
| `USAGE_STATS_LATEST_N` | `200` | Number of latest requests per model for percentile stats |
| `UMANS_API_KEY` | _(empty)_ | Required for `/v1/usage` fetch, concurrency gate sizing, and rate-limit validation |

The upstream target (`https://api.code.umans.ai`), OpenAI chat path
(`chat/completions`), warmer path (`/v1/models`), and vision target are
hardcoded — not configurable.

### TTL stamping

When `STAMP_CACHE_TTL_ENABLED` is on, the proxy:

1. Detects Anthropic-style requests (non-OpenAI routes with JSON bodies)
2. Walks `system` and `messages[].content` arrays
3. Stamps `ttl` onto any `cache_control: {type:"ephemeral"}` block that lacks one

The stamped body is what gets forwarded upstream AND what gets captured — so the inspector shows exactly what went to the API.

Set `STAMP_CACHE_TTL_ENABLED=false` (the default) to disable and run as a transparent passthrough.

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

## Inspector dashboard

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
bun run dev        # start proxy server
bun run typecheck  # TypeScript checking
bun run lint       # Biome lint
bun run lint:fix   # Biome lint + auto-fix
bun run test       # run tests
bun run build      # build server + dashboard
```

## Project structure

```
umans-gate/
├── src/           # TypeScript server modules
│   ├── cli.ts     # CLI entry point
│   ├── index.ts   # createProxyServer() factory + exports
│   ├── config.ts  # env-driven configuration
│   ├── db.ts      # SQLite capture store
│   ├── proxy.ts   # proxy handler (capture + TTL stamping)
│   ├── stamp.ts   # cache_control TTL stamping logic
│   ├── viewer.ts  # inspector dashboard + REST API router
│   ├── ws.ts      # WebSocket broadcast manager
│   ├── queue.ts   # write-behind queue
│   ├── helpers.ts # shared utilities
│   ├── banner.ts  # startup banner
│   └── types.ts   # shared types
├── dashboard/     # React + shadcn/ui dashboard
├── test/          # bun:test test suite
└── public/        # legacy vanilla JS dashboard
```

## License

MIT
