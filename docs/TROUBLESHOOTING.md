# Troubleshooting

> **Applies to:** umans-gate v0.3.25 · **Last updated:** 2026-07-26

Common issues and solutions for umans-gate.

## Server won't start

### Port already in use

```
Error: Failed to listen on 127.0.0.1:1945
```

Another process is using port 1945. Either stop it or change the port:

```bash
# Find what's using the port
lsof -i :1945

# Or change the port
PORT=9001 umans-gate          # npm install
PORT=9001 bun src/cli.ts      # dev
```

### `bun:sqlite` not found

This means you're running with Node.js instead of Bun. If you installed via
npm (`npm install -g umans-gate`), the bundled binary already includes Bun
internally — make sure you're running `umans-gate`, not `node`.

If you're running from source, Bun is required:

```bash
bun --version    # verify Bun is installed
bun src/cli.ts   # start with Bun, not Node
```

### Config file not created

The config file is auto-created on first run at:

- **Linux/macOS**: `~/.config/umans-gate/config.json`
- **Windows**: `%APPDATA%/umans-gate/config.json`

If it's not being created, check that the directory is writable:

```bash
mkdir -p ~/.config/umans-gate
touch ~/.config/umans-gate/config.json
```

## Stamping not working

### Stamps not applied to requests

Check that `stamp_claude_code_enabled` is `true` in your config:

```bash
# Via dashboard: Config tab → toggle stamp_claude_code_enabled
# Or via config.json:
{
  "stamp_claude_code_enabled": true
}
```

Stamps only apply to Anthropic routes (`/v1/messages`). OpenAI-compatible
routes use `stamp_reasoning_effort_enabled` instead.

### `max_tokens` / `thinking` not being removed on OpenAI route

The `stamp_reasoning_effort_enabled` flag removes `max_tokens` and `thinking`
from OpenAI-compatible requests and injects `reasoning_effort`. If you see
errors from the upstream about unrecognized fields, ensure this is enabled:

```json
{
  "stamp_reasoning_effort_enabled": true
}
```

## Vision handoff issues

### Images not being described

1. Check `vision_strategy` — `never` disables vision handoff entirely
2. For `catalog` strategy: verify the model is in the "no vision" catalog.
   Use `always` to intercept all images regardless of model.
3. Check `UMANS_API_KEY` is set — vision calls require it
4. Check `vision_concurrency` — at 1 (default), vision calls are serialized
5. Check the dashboard for vision errors in the capture detail

### Vision descriptions are slow

- Vision calls are serialized (concurrency=1 by default). Increase
  `vision_concurrency` if the upstream supports more vision slots.
- Descriptions are cached for 7 days. First requests will be slow; subsequent
  requests with the same image will be fast.
- Check `vision_max_dimension` — large images are resized before sending.

### Persistent cache not working

```json
{
  "vision_persistent_cache": true
}
```

Descriptions are stored in the same SQLite database as captures. Check that
`db_path` is writable and the database isn't full.

## Concurrency / rate limiting

### Requests timing out in queue

```
GateError: Queue timeout exceeded
```

The concurrency gate's queue is full or the wait exceeded `queue_timeout_ms`
(30s default). Options:

- Increase `concurrency_hard_cap` if your plan allows more concurrent requests
- Increase `queue_timeout_ms` if you can wait longer
- Increase `max_queue_depth` to allow more queued requests

### Circuit breaker keeps opening

The circuit breaker opens after `breaker_threshold` (5) 429 responses in
`breaker_window_ms` (5 min). If it keeps opening:

- Your upstream is rate-limiting you — reduce concurrency or request rate
- Check `/v1/usage` in the dashboard for rate-boxing status
- Increase `breaker_threshold` only if 429s are transient and expected

### Rate limiter blocking requests

If `rate_limit_requests` is set to `0` (auto), the limiter derives limits from
`/v1/usage`. If `UMANS_API_KEY` is not set, the limiter can't fetch usage and
may not function correctly.

To disable rate limiting entirely:

```json
{
  "rate_limit_requests": -1
}
```

## Dashboard issues

### Dashboard not loading

1. Verify the server is running: `curl http://localhost:1945/dashboard/`
2. If you built the dashboard, verify `dashboard/dist/` exists
3. In dev mode, run the dashboard separately: `cd dashboard && bun run dev`
4. Check browser console for WebSocket connection errors

### WebSocket not updating

- Ensure you're connecting to `ws://localhost:1945/dashboard/ws`
- Check `ws_backpressure_limit` — clients exceeding this are disconnected
- Verify no proxy/firewall is blocking WebSocket upgrades

### Config changes not applying

Hot-reloadable fields apply immediately via the Config tab. Fields marked
`restartRequired` need a server restart. Use the **Restart** button in the
dashboard, or restart manually.

## Service / persistence

### Proxy doesn't start after reboot

The `umans-gate` command runs in the foreground — it does **not**
auto-start on boot by itself. You need to install it as a managed
service first:

```bash
umans-gate service install
```

This registers it with systemd (Linux), launchd (macOS), or as a
Windows Service. Check that the service is installed and running:

```bash
umans-gate service status
```

If it was installed but not running, start it:

```bash
umans-gate service start
```

### `service install` from `npx` fails

`npx umans-gate service install` will fail with a clear error — `npx`
installs a temporary binary that won't persist across reboots. Install
the package globally first:

```bash
npm install -g umans-gate
umans-gate service install
```

### Linux: service starts on login but not at boot

On Linux, `service install` uses a systemd user unit with
`loginctl enable-linger` so the service starts at boot without login.
If `enable-linger` fails (it may need root on some distros), the
service will start when you log in instead. Enable linger manually:

```bash
loginctl enable-linger "$USER"
```

If this needs root:

```bash
sudo loginctl enable-linger "$USER"
```

### Service crashes and doesn't restart

The service is configured with automatic restart:

- **Linux**: `Restart=always` in the systemd unit
- **macOS**: `KeepAlive=true` in the launchd plist
- **Windows**: NSSM restarts the process on exit

If it's not restarting, verify the service definition wasn't
corrupted:

```bash
umans-gate service status
umans-gate service install --force   # reinstall the service definition
```

Check the logs for crash reasons:

```bash
umans-gate service logs -f
```

## Database issues

### Database file growing too large

- The ring buffer evicts old captures at `max_captures` (default 200)
- zstd compression (`compression_enabled: true`) reduces body storage
- `capture_body_max_bytes` (default 10 MB) limits per-capture body size
- Run `bun run clean` to remove the database and start fresh (WARNING: deletes all captures)

### Database locked

WAL mode should prevent this, but if it happens:

1. Ensure only one proxy instance is using the database file
2. Check for zombie processes: `ps aux | grep cli.ts`
3. Delete `-wal` and `-shm` files and restart

## Performance

### High latency on first request

The connection warmer (`warmer_enabled: true`) pings the upstream every 20s
to keep TLS warm. The first request after a cold start may take ~750ms longer
due to TLS handshake.

### Streaming responses are slow

- Verify `upstream_protocol` is `http1.1` (default) — benchmarks show it's
  faster than HTTP/2 for typical LLM workloads
- Check concurrency settings — if the gate is queueing, requests wait
- Verify `accept-encoding: identity` is being sent (the proxy forces this)

## Getting help

- [GitHub Issues](https://github.com/codegiveness/umans-gate/issues) — bug reports
- [GitHub Discussions](https://github.com/codegiveness/umans-gate/discussions) — questions
- [Proxy Modifications Inventory](proxy-modifications.md) — what the proxy changes
- [Architecture](ARCHITECTURE.md) — system design
- [Product](PRODUCT.md) — product positioning and users
- [Benchmarks](BENCHMARKS.md) — performance methodology and results
- [Security Policy](../SECURITY.md) — vulnerability reporting and security practices
