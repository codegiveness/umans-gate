# Troubleshooting

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

# Or change the port via env
PORT=9001 bun src/cli.ts
```

### `bun:sqlite` not found

This means you're running with Node.js instead of Bun. umans-gate requires
Bun — `bun:sqlite` is a Bun built-in.

```bash
# Check you're using Bun
bun --version

# Start with Bun, not Node
bun src/cli.ts
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

- [GitHub Issues](https://github.com/umans-ai/umans-gate/issues) — bug reports
- [GitHub Discussions](https://github.com/umans-ai/umans-gate/discussions) — questions
- [Proxy Modifications Inventory](proxy-modifications.md) — what the proxy changes
- [Architecture](ARCHITECTURE.md) — system design
