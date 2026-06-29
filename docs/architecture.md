# umans-gate Architecture

This document explains how umans-gate is structured, how a request flows through the system, and why the concurrency engine cannot over-commit capacity.

## Overview

umans-gate is a small, single-binary API gateway. It sits between an OpenAI-compatible client and one or more upstream AI providers (OpenAI, Anthropic, or any fixed HTTP endpoint). It enforces a strict, weighted per-provider concurrency budget, forwards the `Authorization` header unchanged, streams responses without buffering, and exposes a live dashboard on a second port.

The workspace contains two crates:

- `crates/umans-gate` — the library (types, config, concurrency engine, proxy, dashboard).
- `crates/umans-gate-cli` — the `umans-gate` binary and clap command tree.

Configuration is a single YAML file loaded at startup and optionally reloaded when the file changes. If no config file is supplied and no file exists at the default path, umans-gate fetches the model list from `https://api.code.umans.ai/v1/models/info` and builds a default config with all models at weight `1.0` and provider capacity `4.0`. There is no external database, no Redis, and no load balancer; the gateway is entirely self-contained.

## Component Diagram

```text
                          ┌─────────────────────────────────────────────────────┐
                          │                     Client                          │
                          └──────────────────────┬──────────────────────────────┘
                                                 │
                                                 ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                         Proxy Server                                          │
│                                    bind: 0.0.0.0:8080                                        │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌───────────┐ │
│  │ Axum Router │──▶│ Path Extractor │──▶│ Concurrency  │──▶│   Timeout    │──▶│  Upstream │ │
│  │             │   │ (first path  │   │    Layer     │   │   Layer      │   │   Client  │ │
│  │  /{*path}   │   │   segment)   │   │ (Weighted    │   │ (connect,    │   │ (hyper +  │ │
│  │             │   │              │   │   Permit)    │   │ ttfb, idle,  │   │ rustls)   │ │
│  └─────────────┘   └──────────────┘   └──────────────┘   │ total)       │   └─────┬─────┘ │
│                                                          └──────────────┘         │       │
└───────────────────────────────────────────────────────────────────────────────────┼───────┘
                                                                                    │
                                                                                    ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                     Dashboard Server                                          │
│                                   bind: 0.0.0.0:9090                                          │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌───────────────────────────────┐  │
│  │ rust-embed   │   │ Askama       │   │   SSE        │   │   DashboardState              │  │
│  │ static/      │   │ Templates    │◀──│  Endpoint    │──▶│ (limiter snapshot + cache)    │  │
│  │   htmx, sse  │   │ page.html    │   │ /providers   │   └───────────────────────────────┘  │
│  └──────────────┘   │ fragment.html│   └──────────────┘                                      │
│                     └──────────────┘                                                          │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌──────────────────────────────────────────────────────────────────────────────────────────────┐
│                                   Config + Hot Reload                                       │
│  ┌──────────────┐   ┌───────────────────┐   ┌──────────────────┐   ┌───────────────────┐   │
│  │ figment      │──▶│  ArcSwap<Gateway   │──▶│ ConfigStore      │──▶│ notify-debouncer  │   │
│  │ YAML + ENV   │   │      Config>        │   │ load once/req    │   │ 500 ms debounce    │   │
│  └──────────────┘   └───────────────────┘   └──────────────────┘   └───────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Request Pipeline (10 Steps)

1. **Accept.** The client opens an HTTP/1.1 or HTTP/2 connection to the proxy bind address.
2. **Route.** The catch-all route `/{*path}` captures the request. The handler splits the first path segment off as the provider ID, looks up the matching provider config by `provider.id`, and returns 404 `UnknownProvider` if no match exists.
3. **Load config.** The handler calls `ConfigStore::load()` exactly once, pinning the active configuration version for the entire request lifetime.
4. **Acquire capacity.** The Tower concurrency layer calls `ProviderLimiter::acquire` using the provider ID and model weight. If the provider is at capacity, the request waits in the tokio semaphore queue.
5. **Start timers.** The timeout layer initializes the four-level hierarchy: connect, TTFB, stream idle, and total.
6. **Build upstream request.** The upstream client copies the original method, headers, and body, strips the provider prefix, normalizes the remaining path to start with `/v1/` (preserving `/v1/` when it is already present), and sets the upstream URL from the active provider config.
7. **Forward over TLS.** `hyper-rustls` opens the TLS connection through a pooled `hyper-util` client, using the web PKI root store.
8. **Stream response.** The response body is returned as a poll-driven stream. The `WeightedPermit` is moved into the stream body so it is released only when the stream ends or the consumer disconnects.
9. **Release capacity.** When the stream finishes or drops, the permit's `Drop` implementation returns the model weight to the provider semaphore and emits a `MetricUpdate::Released` event.
10. **Error transform.** Any `GatewayError` produced along the way is converted by the error middleware into an OpenAI-style JSON response with a `Retry-After` header when appropriate.

## Concurrency Engine

Each provider owns an independent `tokio::sync::Semaphore`. The semaphore is initialized with the provider's capacity converted to fixed-point milliunits.

Config-side weights are `f32` values such as `1.0`, `0.5`, or `0.25`. Internally, every weight is multiplied by 1000 and stored as a `u32`:

- capacity `4.0` -> `4000` milliunits
- weight `1.0` -> `1000` milliunits
- weight `0.25` -> `250` milliunits

When a request arrives, the concurrency layer calls `acquire_many_owned` on the provider's `Arc<Semaphore>` for the model's weight in milliunits. The returned `OwnedSemaphorePermit` is stored inside a `WeightedPermit`. The `WeightedPermit` is then moved into the response stream. Its `Drop` handler decrements a relaxed `AtomicU32` mirror and emits a metric event, but the mirror is for the dashboard only.

### Zero-race proof

The engine is race-free for three reasons:

1. **The semaphore is authoritative.** `tokio::sync::Semaphore` already guarantees that however many permits are outstanding never exceeds the configured capacity. There is no user-level CAS deciding whether a request may proceed.
2. **No float arithmetic in the hot path.** Weights are converted to `u32` milliunits once at startup. Acquiring and releasing capacity uses integer permit counts, so there is no floating-point compare-and-swap and no rounding race.
3. **Ownership tracks the permit.** The `OwnedSemaphorePermit` is not held in the handler scope. It is moved into the stream body, so release happens exactly when the stream is consumed or dropped. Client disconnect, upstream completion, and error paths all release the same way through RAII.

Because the semaphore is the single source of truth, the relaxed atomic mirror used by the dashboard can never cause over-concurrency even if it lags behind.

## Hot Reload

Config file watching is enabled by default; start with `--no-watch` to opt out. `ConfigStore::watch` spawns a `notify-debouncer-mini` watcher on the config file with a 500 ms debounce. When the file changes, the new YAML is loaded and validated through `GatewayConfig::load`. If validation passes, `ConfigStore::reload` updates the `ArcSwap` and rebuilds the concurrency map.

Provider recreation follows these rules:

- New providers are registered with a fresh semaphore sized to their capacity.
- Removed providers are removed from the limiter map and their semaphore is closed, so any queued waiters fail fast.
- In-flight requests keep their original `Arc<ProviderState>`; they are not interrupted by the reload.

A handler always calls `load()` once per request and keeps the returned guard for the request lifetime, so a reload never splits a single request across two config versions.

## Dashboard Architecture

The dashboard is served on `dashboard_bind` and has three parts:

- **Static assets.** `rust-embed` embeds `static/htmx.min.js` and `static/sse.js` into the binary. The `static_handler` serves them by path and MIME type.
- **Templates.** Askama compiles `templates/dashboard.html` and `templates/provider_fragment.html` at build time. The page uses HTMX+SSE attributes to open a server-sent event stream.
- **Live data.** `DashboardState` holds the `ProviderLimiter` and receives `MetricUpdate` events through a shared `broadcast::channel`. The SSE endpoint (`/providers`) renders an initial snapshot, then listens for updates and re-renders the provider fragment each time a permit is acquired or released.

The dashboard shows, per provider:

- capacity and consumed weight
- utilization percentage
- active model counts (pending and active states distinguished in the fragment)
- a request list sorted oldest→newest, showing each request's enqueued-at timestamp, provider, model, weight, status, age, and client/upstream i/o protocol version

### Dashboard Configuration

The dashboard is configured through the top-level `dashboard` key in `config.yaml` and two CLI overrides.

```yaml
dashboard:
  bind: "0.0.0.0:3001"
  history:
    max: 1000
  kill_button:
    min_age_seconds: 300
```

- `dashboard.history.max` sets the number of completed requests kept in the history store. Use `0` to keep an unlimited number of records.
- `dashboard.kill_button.min_age_seconds` controls how many seconds a request must be queued or running before the kill button appears.

The same values can be overridden at startup with CLI flags:

```bash
umans-gate serve --config config.yaml --history-max 2000 --kill-min-age-seconds 60
```

`--history-max` caps the number of history records, with `0` meaning unlimited. `--kill-min-age-seconds` sets the minimum age for the kill button.

Timeouts can be disabled for a phase by setting them to YAML `null` (infinity), or supplied as a finite `{ secs, nanos }` struct:

```yaml
providers:
  - id: umans
    upstream_url: "https://api.code.umans.ai"
    capacity: 4.0
    timeouts:
      connect: null
      ttfb: null
      stream_idle: { secs: 300, nanos: 0 }
      total: null
```

Set a finite override such as `{ secs: 10, nanos: 0 }`. A `null` value removes that phase ceiling entirely, so the request is never timed out for that phase.

### CSV Export

The dashboard exposes a CSV export of terminal request history at `/dashboard/history/export.csv`. The file includes headers and one row per completed, rejected, timed-out, or cancelled request.

```bash
curl http://localhost:3001/dashboard/history/export.csv
```

The export is served on `dashboard.bind`, not the legacy `dashboard_bind` value.

### Stop-Reason Header

When a request is killed from the dashboard, the gateway sets:

```text
X-Umans-Stop-Reason: cancelled
```

The header is sent on the 400 `request_cancelled` response returned to the downstream client.

### Anti-Spam Harness Contract

Downstream clients should treat gateway responses as a contract for retries and backoffs. The gateway itself does not apply global rate limiting; the harness is expected to read status codes and headers.

| Status | Header | Meaning |
|---|---|---|
| 503 Service Unavailable | `Retry-After: 30` | Concurrency limit reached; wait for the given number of seconds and retry. |
| 504 Gateway Timeout | none | A phase or total timeout fired; retry with backoff after confirming transient conditions. |
| 502 Bad Gateway | none | Upstream error; retry after confirming upstream health. |
| 429 Too Many Requests | `Retry-After: <seconds>` | Upstream provider rate limited the request; wait for the given duration and retry. |
| 4xx (other than 429) | none | Client-side error; do not retry without fixing the request. |
| Dashboard kill | `X-Umans-Stop-Reason: cancelled` | The request was cancelled by an operator; terminal failure, do not retry. |

A compact rule for harness authors: a 4xx response without `Retry-After` should never be retried; 5xx responses, 503, 504, and 429 should be retried with a backoff; dashboard kills are terminal.

### Dashboard Security Warning

The dashboard has no authentication and binds to `0.0.0.0:3001` by default. Do not expose it to untrusted networks. Bind it to a private interface or place it behind an authenticating reverse proxy. Exposing the dashboard publicly creates a denial-of-service risk because unauthenticated callers can view active requests and trigger request kills.

## Timeout Hierarchy

Each provider can override the AI-tuned defaults.

| Timeout        | Default   | Purpose                                                                 |
|----------------|-----------|-------------------------------------------------------------------------|
| `connect`      | `null`    | Max time to establish the TCP/TLS connection to the upstream. `null` means infinity. |
| `ttfb`         | `null`    | Max time from sending the request to receiving the first response byte. `null` means infinity. |
| `stream_idle`  | `300s`    | Max silence between two SSE chunks while the stream is open.            |
| `total`        | `null`    | Hard ceiling for the entire request/response lifecycle. `null` means infinity.                 |

Timeouts are nested: `connect` < `ttfb` < `stream_idle` < `total`. A request fails as soon as the tightest applicable timeout fires.

## Graceful Shutdown

The CLI installs signal handlers for the three standard POSIX signals:

| Signal   | Behavior                                                              |
|----------|-----------------------------------------------------------------------|
| `SIGTERM`| Start graceful drain; wait up to `30s` for in-flight streams, then force-close. |
| `SIGINT` | Start graceful drain; wait up to `5s`, then force-close.             |
| `SIGQUIT`| Immediate shutdown with no drain.                                      |

During the drain window the proxy stops accepting new connections and waits for active `WeightedPermit`s to drop. Because each permit lives inside the stream body, the engine can count outstanding capacity accurately and decide when the drain is complete.

## Error Format

Errors are returned as OpenAI-compatible JSON:

```json
{
  "error": {
    "message": "concurrency limit exceeded for provider umans",
    "type": "gateway_error"
  }
}
```

For concurrency-limit errors the response includes:

```text
HTTP/1.1 503 Service Unavailable
Retry-After: 30
Content-Type: application/json
```

Other gateway-level errors map to 502 (upstream/timeout) or 500 (internal) as appropriate.

## Self Update

The CLI update command uses `self_update` to query GitHub Releases and `self_replace` to swap the running binary on disk. On Windows the operation is non-atomic, so the command creates a backup before replacing the executable and documents the restore path on failure. Use `--dry-run` to check for a newer release without installing it.

## Developer Guide

### Build

```bash
cargo build --release
```

The release binary is at `target/release/umans-gate`.

### Test

```bash
# full suite including hot-reload
cargo test --workspace --features hot-reload

# concurrency engine only
cargo test -p umans-gate concurrency::tests

# config loader and validation
cargo test -p umans-gate config::tests
```

### Lint

```bash
cargo clippy --workspace -- -D warnings
```

### Extend

To add a new provider:

1. Add an entry to `providers` in your config YAML with a unique `id`, `upstream_url`, and capacity.
2. Add the models the provider serves under `models` with positive weights not exceeding capacity.
3. Optionally set custom `timeouts` for that provider.

To change routing, edit `crates/umans-gate/src/proxy/router.rs`. To change how capacity is visualized on the dashboard, edit the Askama templates in `templates/` and the fragment renderer in `crates/umans-gate/src/dashboard/sse.rs`.
