# umans-gate Architecture

This document explains how umans-gate is structured, how a request flows through the system, and why the concurrency engine cannot over-commit capacity.

## Overview

umans-gate is a small, single-binary API gateway. It sits between an OpenAI-compatible client and one or more upstream AI providers (OpenAI, Anthropic, or any fixed HTTP endpoint). It enforces a strict, weighted per-provider concurrency budget, forwards the `Authorization` header unchanged, streams responses without buffering, and exposes a live dashboard on a second port.

The workspace contains two crates:

- `crates/umans-gate` — the library (types, config, concurrency engine, proxy, dashboard).
- `crates/umans-gate-cli` — the `umans-gate` binary and clap command tree.

Configuration is a single YAML file loaded at startup and optionally reloaded when the file changes. There is no external database, no Redis, and no load balancer; the gateway is entirely self-contained.

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

When the CLI starts with `--watch`, `ConfigStore::watch` spawns a `notify-debouncer-mini` watcher on the config file with a 500 ms debounce. When the file changes, the new YAML is loaded and validated through `GatewayConfig::load`. If validation passes, `ConfigStore::reload` updates the `ArcSwap` and rebuilds the concurrency map.

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

There is no authentication on the dashboard. Bind it to a private interface or place it behind a reverse proxy when running on an untrusted network.

## Timeout Hierarchy

Each provider can override the AI-tuned defaults.

| Timeout        | Default | Purpose                                                                 |
|----------------|---------|-------------------------------------------------------------------------|
| `connect`      | `10s`   | Max time to establish the TCP/TLS connection to the upstream.        |
| `ttfb`         | `30s`   | Max time from sending the request to receiving the first response byte. |
| `stream_idle`  | `60s`   | Max silence between two SSE chunks while the stream is open.            |
| `total`        | `300s`  | Hard ceiling for the entire request/response lifecycle.                 |

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
    "message": "concurrency limit exceeded for provider openai",
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
