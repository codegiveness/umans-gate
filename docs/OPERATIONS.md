# Operations

> **Applies to:** umans-gate v0.6.1 · **Last updated:** 2026-07-31

umans-gate operations: start/stop, upgrades, health checks, backup, and
configuration management. For reactive problem-solving, see
[TROUBLESHOOTING.md](TROUBLESHOOTING.md).

## Start and stop

### Foreground (default)

```bash
umans-gate          # starts on http://localhost:1945
```

`umans-gate` runs in the foreground and stops with `Ctrl+C`. It does not
survive reboots unless installed as a managed service.

### Managed service

```bash
umans-gate service install        # register (systemd / launchd / Windows Service)
umans-gate service start
umans-gate service stop
umans-gate service restart
umans-gate service status
umans-gate service logs -f
umans-gate service uninstall
```

| Platform | Service manager | Unit location |
|----------|----------------|---------------|
| Linux | systemd (user unit + linger) | `~/.config/systemd/user/umans-gate.service` |
| macOS | launchd (LaunchAgent) | `~/Library/LaunchAgents/com.umans.gate.plist` |
| Windows | Windows Service (via NSSM) | Registered with `sc.exe` |

The service uses `Restart=always` / `KeepAlive=true` and auto-starts on
boot. When running as a managed service, the dashboard **Restart** button
works automatically.

### Port conflicts

Default listen port is `1945`. Change it via env or config:

```bash
PORT=9001 umans-gate          # npm install
PORT=9001 bun src/cli.ts      # dev
```

## Health checks

### HTTP endpoints

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /health` | `DASHBOARD_TOKEN` if set | Liveness probe, returns `200 OK` |
| `GET /metrics` | `DASHBOARD_TOKEN` if set | Basic metrics (capture count, uptime) |
| `GET /dashboard/api/captures` | `DASHBOARD_TOKEN` if set | Recent captures (JSON) |
| `GET /dashboard/api/gate` | `DASHBOARD_TOKEN` if set | Concurrency gate state |
| `WS /dashboard/ws` | `?token=<token>` if set | Live updates |

When `DASHBOARD_TOKEN` is set, all `/dashboard/api/*` routes, `/health`, and
`/metrics` require `Authorization: Bearer <token>`. WebSocket requires
`?token=<token>`. Includes brute-force protection.

### Dashboard

Open `http://localhost:1945/dashboard/` for the live inspector. The dashboard
has these tabs:

- **Captures**: live request/response list with SSE rendering
- **Vision**: vision call records and cache stats
- **Performance**: per-model TTFT, TPS, token throughput
- **Economics**: daily/monthly cost tracking
- **Usage**: upstream `/v1/usage` heatmap and timeline
- **Models**: upstream model catalog with pricing
- **Config**: edit, validate, hot-reload, restart

## Upgrades

### Self-update

```bash
umans-gate update            # self-update (npm global or standalone binary)
umans-gate update --check    # check without installing
```

The updater detects install method and acts accordingly. If running as a
managed service, it stops before update and restarts after. Pass
`--keep-config` to preserve `config.json` and the database.

```bash
umans-gate uninstall         # removes service, config, database, binary
```

### One-click dashboard update

Available only when running as a managed service with `DASHBOARD_TOKEN`
set. The dashboard performs a pre-flight check, then asynchronously
stops/updates/starts the service.

### Manual upgrade (from source)

```bash
git pull
bun install
cd dashboard && bun install && bun run build && cd ..
bun run build
umans-gate service restart   # if running as managed service
```

## API key management

### Set the upstream API key

```bash
export UMANS_API_KEY=your-key-here
# Or edit config.json: umans-gate config show
# Or use the dashboard Config tab
```

Without `UMANS_API_KEY`, the proxy still captures traffic, but disables
`/v1/usage` polling, concurrency gate sizing, rate-limit validation, and
vision handoff.

### Rotate the API key

1. Set the new key via env, config.json, or Config tab
2. If running as a managed service, the key is stored in a separate
   `EnvironmentFile` (systemd, `chmod 600`), the plist (launchd), or the
   service registry (Windows). Update it there, then `service restart`.
3. If `DASHBOARD_TOKEN` is set, rotate it the same way.

### Secure the dashboard

```bash
export DASHBOARD_TOKEN=your-secret-token
```

When set, all dashboard API routes, `/health`, `/metrics`, and WebSocket
require the token. Includes brute-force protection.

## Database management

### Location

Default path is `./umans-gate.db` (project root). Change via `DB_PATH` env or
the `db_path` config field; this requires a server restart.

### Backup

```bash
# Stop the proxy first to ensure a consistent snapshot
umans-gate service stop
cp umans-gate.db umans-gate.db.backup
umans-gate service start
```

WAL mode allows hot backup via `sqlite3 umans-gate.db ".backup backup.db"`,
but stopping first is safer for personal-use workflows.

### Size management

- Ring buffer evicts old captures at `max_captures` (default 200).
- zstd compression (`compression_enabled: true`) reduces body storage.
- `capture_body_max_bytes` (default 10 MB) limits per-capture body size.
- Run `bun run clean` to remove the database and start fresh (this deletes all
  captures).

### Locked database

If the database locks despite WAL mode:

1. Ensure only one proxy instance is using the database file.
2. Check for zombie processes: `ps aux | grep cli.ts`.
3. Delete `-wal` and `-shm` files and restart.

## Configuration

### Config file

| OS | Path |
|----|------|
| Linux/macOS | `$XDG_CONFIG_HOME/umans-gate/config.json` or `~/.config/umans-gate/config.json` |
| Windows | `%APPDATA%/umans-gate/config.json` |

Precedence is env vars > JSON config > built-in defaults. On first run,
`loadConfig()` writes defaults if the file does not exist. Existing configs are
never overwritten.

### Hot-reload vs restart

The Config tab can save and hot-reload via `POST /dashboard/api/config/reload`.

**Hot-reloadable:** all fields except those marked `restartRequired` (see
`src/config/reload.ts`, `RELOAD_FIELDS` for the full hot-reloadable set,
`RESTART_REQUIRED_FIELDS` for the restart-required set).

**Restart required:** fields marked `restartRequired` (e.g. `port`,
`db_path`, `upstream_protocol`, `vision_strategy`, `vision_model`,
`warmer_*`, `umans_api_key`, `dashboard_token`).

See [AGENTS.md](../AGENTS.md) for the complete config field table.

## Connection warmer

The connection warmer (`warmer_enabled: true`, interval 20000ms) pings
`/v1/models` upstream to keep TLS warm. It skips pings when real traffic
occurred recently. The first request after a cold start may take ~750ms longer
due to the TLS handshake.

## See also

- [TROUBLESHOOTING.md](TROUBLESHOOTING.md): reactive problem-solving
- [ARCHITECTURE.md](ARCHITECTURE.md): system design and data flow
- [AGENTS.md](../AGENTS.md): complete config field table
- [proxy-modifications.md](proxy-modifications.md): every modification the proxy applies
