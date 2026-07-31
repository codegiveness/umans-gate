# Troubleshooting

> **Applies to:** umans-gate v0.6.1 · **Last updated:** 2026-07-31

Common issues and solutions for running umans-gate.

## What to do if the server won't start

### Port already in use

```
Error: Failed to listen on 127.0.0.1:1945
```

Port `1945` is already in use. Stop the other process or change the port:

```bash
# Find what's using the port
lsof -i :1945

# Or change the port
PORT=9001 umans-gate          # npm install
PORT=9001 bun src/cli.ts      # dev
```

### `bun:sqlite` not found

The `bun:sqlite` error means the runtime is Node.js, not Bun.

If you installed via npm (`npm install -g umans-gate`), the bundled binary
includes Bun internally. Run `umans-gate`, not `node`.

If you run from source, Bun is required:

```bash
bun --version    # verify Bun is installed
bun src/cli.ts   # start with Bun, not Node
```

### Config file not created

The config file auto-creates on first run at:

- **Linux/macOS**: `~/.config/umans-gate/config.json`
- **Windows**: `%APPDATA%/umans-gate/config.json`

If it is not created, check that the directory is writable:

```bash
mkdir -p ~/.config/umans-gate
touch ~/.config/umans-gate/config.json
```

## What to do if stamping is not working

### Stamps not applied to requests

Stamps only apply when `stamp_claude_code_enabled` is `true` (default is now `true`; this section helps users who turned it off):

```bash
# Via dashboard: Config tab → toggle stamp_claude_code_enabled
# Or via config.json:
{
  "stamp_claude_code_enabled": true
}
```

Claude Code stamps apply to Anthropic routes (`/v1/messages`).
OpenAI-compatible routes use `stamp_reasoning_effort_enabled` instead.

### `output_config` / `context_management` not being stripped on OpenAI route

The `stamp_reasoning_effort_enabled` flag injects `reasoning_effort`,
strips `output_config` and `context_management`, and forces
`temperature: 1.0` on OpenAI-compatible requests. The `thinking` field is
controlled by `stamp_model_rules` (`PerModelRuleStep`, ADR-0029), not by
`reasoning_effort` stamping. Enable the flag if upstream rejects
Anthropic-specific fields:

```json
{
  "stamp_reasoning_effort_enabled": true
}
```

To override the thinking shape for a specific model family on OpenAI
routes, add a per-model rule with `openai_thinking_shape`:

```json
{
  "stamp_model_rules": [
    {
      "pattern": "umans-kimi-k2.7",
      "openai_thinking_shape": { "type": "enabled", "keep": "all" },
      "openai_veto_reasoning_effort": true
    }
  ]
}
```

See [ADR-0029](adr/0029-per-model-stamp-rules-table.md) for the full
per-model rules spec and target table.

## What to do if the vision handoff is not working

### Images not being described

1. Check `vision_strategy`. `never` disables vision handoff entirely.
2. For `catalog` strategy: verify the model is in the "no vision" catalog,
   or use `always` to intercept all images regardless of model.
3. Check `UMANS_API_KEY` is set. Vision calls require it.
4. Check `vision_concurrency`. At 1 (default), vision calls are serialized.
5. Check the dashboard for vision errors in the capture detail.

### Vision descriptions are slow

- Vision calls are serialized (concurrency = 1 by default). Increase
  `vision_concurrency` if the upstream supports more vision slots.
- Descriptions are cached for 7 days. First requests are slow; subsequent
  requests with the same image are fast.
- Check `vision_max_dimension`. Large images are resized before sending.

### Persistent cache not working

```json
{
  "vision_persistent_cache": true
}
```

Descriptions are stored in the same SQLite database as captures. Check that
`db_path` is writable and the database is not full.

## What to do if concurrency or rate limiting is blocking requests

### Requests timing out in queue

```
GateError: Queue timeout exceeded
```

The concurrency gate queue is full or the wait exceeded `queue_timeout_ms`
(default 180 seconds). Options:

- Increase `concurrency_hard_cap` if your plan allows more concurrent requests.
- Increase `queue_timeout_ms` if you can wait longer.
- Increase `max_queue_depth` to allow more queued requests.

### Circuit breaker keeps opening

The circuit breaker opens after 5 HTTP 429 responses within 5 minutes
(`breaker_threshold` / `breaker_window_ms`). If it keeps opening:

- Your upstream is rate-limiting you. Reduce concurrency or request rate.
- Check `/v1/usage` in the dashboard for rate-boxing status.
- Increase `breaker_threshold` only if 429 responses are transient and expected.

### Rate limiter blocking requests

If `rate_limit_requests` is `0` (auto), the limiter derives the limit from
`/v1/usage`. If `UMANS_API_KEY` is not set, the limiter cannot fetch usage and
may not function correctly.

To disable rate limiting entirely, set `rate_limit_requests` to `-1`:

```json
{
  "rate_limit_requests": -1
}
```

## What to do if the dashboard is not working

### Dashboard not loading

1. Verify the server is running: `curl http://localhost:1945/dashboard/`
2. If you built the dashboard, verify `dashboard/dist/` exists
3. In dev mode, run the dashboard separately: `cd dashboard && bun run dev`
4. Check browser console for WebSocket connection errors

### WebSocket not updating

- Ensure you're connecting to `ws://localhost:1945/dashboard/ws`
- Check `ws_backpressure_limit`. Clients exceeding this are disconnected.
- Verify no proxy/firewall is blocking WebSocket upgrades

### Config changes not applying

Hot-reloadable fields apply immediately via the Config tab. Fields marked
`restartRequired` need a server restart. Click the dashboard **Restart** button
or restart manually.

## What to do if the service or persistence is not working

### Proxy doesn't start after reboot

The `umans-gate` command runs in the foreground; it does **not**
auto-start on boot by itself. Install it as a managed service first:

```bash
umans-gate service install
```

This registers the proxy with systemd (Linux), launchd (macOS), or Windows
Service. Check that the service is installed and running:

```bash
umans-gate service status
```

If it is installed but not running, start it:

```bash
umans-gate service start
```

### `service install` from `npx` fails

`npx umans-gate service install` fails because `npx` installs a temporary
binary that does not persist across reboots. Install the package globally first:

```bash
npm install -g umans-gate
umans-gate service install
```

### Linux: service starts on login but not at boot

On Linux, `service install` uses a systemd user unit with
`loginctl enable-linger` so the service starts at boot without login.
If `enable-linger` fails (it may need root on some distros), the service starts
when you log in instead. Enable linger manually:

```bash
loginctl enable-linger "$USER"
```

If this needs root:

```bash
sudo loginctl enable-linger "$USER"
```

### Service crashes and doesn't restart

The service is configured with automatic restart:

- **Linux**: `Restart=always` in the systemd unit.
- **macOS**: `KeepAlive=true` in the launchd plist.
- **Windows**: NSSM restarts the process on exit.

If it is not restarting, verify the service definition is not corrupted:

```bash
umans-gate service status
umans-gate service install --force   # reinstall the service definition
```

Check the logs for crash reasons:

```bash
umans-gate service logs -f
```

## What to do if the database has problems

### Database file growing too large

- The ring buffer evicts old captures at `max_captures` (default 200).
- zstd compression (`compression_enabled: true`) reduces body storage.
- `capture_body_max_bytes` (default 10 MB) limits per-capture body size.
- Run `bun run clean` to remove the database and start fresh (this deletes all captures).

### Database locked

If the database locks despite WAL mode:

1. Ensure only one proxy instance is using the database file.
2. Check for zombie processes: `ps aux | grep cli.ts`.
3. Delete `-wal` and `-shm` files and restart.

## What to do if performance is slower than expected

### High latency on first request

The connection warmer (`warmer_enabled: true`) pings upstream every 20 seconds
to keep TLS warm. The first request after a cold start may take ~750ms longer
due to the TLS handshake.

### Streaming responses are slow

- Verify `upstream_protocol` is `http1.1` (default). Benchmarks show it is
  faster than HTTP/2 for typical LLM workloads.
- Check concurrency settings. If the gate is queueing, requests wait.
- Verify `accept-encoding: identity` is being sent (the proxy forces this).

## Where to get more help

- [Operations](OPERATIONS.md): start/stop, upgrades, health checks, backup.
- [GitHub Issues](https://github.com/codegiveness/umans-gate/issues): bug reports.
- [GitHub Discussions](https://github.com/codegiveness/umans-gate/discussions): questions.
- [Proxy Modifications Inventory](proxy-modifications.md): every modification the proxy applies.
- [Architecture](ARCHITECTURE.md): system design.
- [Product](PRODUCT.md): product positioning and users.
- [Benchmarks](BENCHMARKS.md): performance methodology and results.
- [Security Policy](../SECURITY.md): vulnerability reporting and security practices.
