# umans-gate

![GitHub Release](https://img.shields.io/github/v/release/umans-ai/umans-gate)
![License](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue)
![Rust Version](https://img.shields.io/badge/rust--version-1.75-orange)

> Weighted concurrency API gateway for AI providers

## TL;DR

umans-gate is a Rust API gateway that proxies requests to OpenAI and Anthropic while enforcing strict, weighted concurrency limits per provider. It forwards the original `Authorization` header untouched, streams SSE responses chunk by chunk without buffering, and serves a live HTMX+SSE dashboard on a separate port. Configuration is a single YAML file, and the binary can install, update, and uninstall itself.

## Features

- Path-based proxy routing for `/{provider.id}/*`, where each provider declared in `config.yaml` becomes its own route prefix.
- Weighted per-provider concurrency limits backed by a fixed-point semaphore engine.
- Zero-race accounting using milliunit weights inside `tokio::sync::Semaphore`.
- Full SSE streaming passthrough with backpressure and no response buffering.
- Live dashboard showing per-provider consumed weight, capacity, and active models.
- YAML configuration with file-watch hot-reload (enabled by default).
- Self-updating CLI with shell completion generation.
- Pure Rust TLS backend via rustls.

## Quick Start

1. Install the binary.
2. Copy `examples/config.yaml` to `config.yaml`.
3. Run `umans-gate serve --config config.yaml`.
4. Point your client at `http://localhost:8080/{provider.id}` (for example, `/umans/v1/chat/completions`).
5. Open `http://localhost:9090` for the live dashboard.

## Installation

### Shell (curl)

```bash
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/umans-ai/umans-gate/releases/latest/download/umans-gate-installer.sh | sh
```

### PowerShell

```powershell
powershell -c "irm https://github.com/umans-ai/umans-gate/releases/latest/download/umans-gate-installer.ps1 | iex"
```

### Homebrew

```bash
brew install umans-ai/tap/umans-gate
```

### Cargo

```bash
# Install the latest release from git.
cargo install --locked --git https://github.com/umans-ai/umans-gate umans-gate-cli
```

Or build from a local checkout:

```bash
cargo install --path crates/umans-gate-cli
```

In all cases the installed binary name is `umans-gate`.

## Configuration

umans-gate reads a single YAML configuration file. The default path is `config.yaml` in the working directory, or you can pass `--config <path>`.

If no config file exists, umans-gate automatically fetches the model list from `https://api.code.umans.ai/v1/models/info` and creates a default configuration with all models at weight 1.0 and capacity 4.0.

### Example `config.yaml`

```yaml
bind: "0.0.0.0:8080"
dashboard_bind: "0.0.0.0:9090"
providers:
  - id: umans
    upstream_url: "https://api.code.umans.ai"
    capacity: 4.0
    models:
      - id: umans-kimi-k2.7
        weight: 1.0
      - id: umans-glm-5.2
        weight: 1.0
      - id: umans-coder
        weight: 1.0
      - id: umans-glm-5.2-nvfp4
        weight: 1.0
      - id: umans-flash
        weight: 1.0
      - id: umans-qwen3.6-35b-a3b
        weight: 1.0
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `bind` | string | `0.0.0.0:8080` | Address and port for the proxy server. |
| `dashboard_bind` | string | `0.0.0.0:9090` | Address and port for the live dashboard. |
| `providers` | list | required | List of upstream AI providers. |
| `providers[].id` | string | required | Provider identifier; used for routing. |
| `providers[].upstream_url` | string | required | Base URL of the upstream API. |
| `providers[].capacity` | float | required | Maximum concurrent weight the provider can hold. |
| `providers[].models` | list | required | Models that belong to this provider. |
| `providers[].models[].id` | string | required | Model identifier. |
| `providers[].models[].weight` | float | required | Concurrency weight charged while a request is active. |
| `providers[].timeouts.connect` | duration or `null` | `null` (infinity) | TCP connect timeout; `null` disables the limit. |
| `providers[].timeouts.ttfb` | duration or `null` | `null` (infinity) | Time to first byte timeout; `null` disables the limit. |
| `providers[].timeouts.stream_idle` | duration or `null` | `300s` | Idle timeout between SSE chunks; `null` disables the limit. |
| `providers[].timeouts.total` | duration or `null` | `null` (infinity) | Hard total timeout per request; `null` disables the limit. |
| `dashboard.history.max`<br>`--history-max` | integer | `1000` | Completed requests kept in dashboard history. `0` means unlimited. `--history-max` overrides the config value. |
| `dashboard.kill_button.min_age_seconds`<br>`--kill-min-age-seconds` | integer | `300` | Minimum age in seconds before the kill button appears. `--kill-min-age-seconds` overrides the config value. |

Model weights must be greater than zero and may not exceed the provider capacity. The loader rejects invalid configs and refuses to start.

## Usage

Run the gateway with a config file:

```bash
umans-gate serve --config config.yaml
```

Run in the foreground with default `config.yaml`:

```bash
umans-gate
```

Config file watching is enabled by default and hot-reloads limits on changes. Use `--no-watch` to disable it:

```bash
umans-gate serve --config config.yaml --no-watch
```

Check for a newer release without installing:

```bash
umans-gate update --dry-run
```

Install the latest release:

```bash
umans-gate update
```

Remove the binary:

```bash
umans-gate uninstall --yes
```

Generate shell completions:

```bash
umans-gate completions bash
umans-gate completions zsh
umans-gate completions fish
umans-gate completions powershell
```

## Routing

The gateway routes by the first path segment. Every provider declared in `config.yaml` exposes its own prefix:

| Prefix | Upstream |
|---|---|
| `/{provider.id}/*` | `providers[].id == {provider.id}` |

With the `umans` provider from `config.yaml`:

- `POST /umans/v1/chat/completions` is forwarded to the `umans` provider as `/v1/chat/completions`.
- `GET /umans/models` is normalized to `/v1/models` and forwarded; `/umans/v1/models` is forwarded as-is without a double `/v1/`.

The provider prefix is stripped and the remaining path is normalized before forwarding. Paths that already contain `v1/` are not double-prefixed, and paths that omit it have `v1/` added automatically. Requests without a recognized provider prefix, such as `/v1/chat/completions`, return `404`.

The `/health` endpoint on the proxy port remains unchanged and returns `ok`.

## Dashboard

The dashboard is served on `dashboard_bind` and uses HTMX with Server-Sent Events. It renders the current consumed weight, capacity bar, and active model list for every configured provider. The request list also shows each request's enqueued-at time and its client/upstream i/o protocol version.

**Security warning:** the dashboard has **no authentication** and binds to `0.0.0.0` by default. Do not expose it to the public internet. Run it behind a reverse proxy or bind it to a private interface unless you are on a trusted network.

## Architecture

The gateway is built as a Rust workspace with two crates:

- `crates/umans-gate` — library containing the concurrency engine, config loader, proxy handlers, dashboard state, and SSE endpoints.
- `crates/umans-gate-cli` — the `umans-gate` binary and clap CLI.

For pipeline diagrams and a developer-oriented breakdown, see [docs/architecture.md](docs/architecture.md).

## Request Flow

```mermaid
flowchart LR
    subgraph Downstream
        Client([Downstream client]) -->|POST /umans/v1/chat/completions| Handler[axum handler<br/>src/proxy/handler.rs]
        Handler --> Normalize{Normalize path<br/>strip provider prefix}
        Normalize --> Buffer[Buffer request body]
        Buffer --> Gate{Acquire model weight<br/>ProviderLimiter::acquire}
    end

    Gate -->|weight available| Build[Build upstream HTTP/1.1 request]
    Gate -->|queue full| Return503[Return 503]
    Build --> ClientPool[hyper legacy client pool<br/>HTTP/1.1 only]
    ClientPool --> UpstreamServer[api.code.umans.ai]

    subgraph Upstream
        UpstreamServer -->|SSE stream chunks| Stream[Yield frames to client]
        Other([Other clients on same API key]) --> UpstreamServer
    end

    Stream --> StillThere{Client still connected?}
    StillThere -->|yes| Stream
    StillThere -->|drops early| DropStream[Generator drops permit & upstream body]
    DropStream --> Race[Race window: upstream still generating until EPIPE]
    Race --> Next[Next queued request reaches provider]
    Next --> Counter[Provider counts account-wide<br/>concurrent sessions]
    Counter -->|over 4 repeatedly| Four29[429 / rate_limited]
    Four29 --> Boxed[boxed_until 5-hour pause]
    StillThere -->|no / [DONE]| EOS[Stream ends normally]
    EOS --> Release[Permit drops on EOS]
    Release --> Reuse[Connection returns to pool]
```

The request enters the `umans-gate` handler, the model weight is acquired, and an HTTP/1.1 request is sent to `api.code.umans.ai`. The response is streamed back as SSE. The failure mode described in `.omo/research-umans-429-ban.md` happens when the downstream client disconnects early: the gateway drops its permit synchronously and can admit the next queued request, while the upstream provider continues to count the cancelled stream as live until it hits a write error. Because the provider counts **concurrent sessions across the whole account** (including other clients sharing the same key), that transient overlap can push the account over 4, register as a 429, and eventually trigger a 5-hour `boxed_until` penalty.

## Weight System

Each model declares a floating-point weight such as `0.5` or `1.0`. Internally the gateway stores weights as fixed-point `u32` milliunits by multiplying by 1000. A weight of `1.0` becomes 1000 milliunits; a weight of `0.25` becomes 250 milliunits.

Each provider owns a `tokio::sync::Semaphore` initialized with `capacity * 1000` permits. When a request starts, the gateway atomically acquires the model weight from the provider semaphore. When the request ends or the client disconnects, the RAII permit drops and the weight is released. All weight accounting uses integer milliunits in the hot path, so there is no floating-point compare-and-swap race. The dashboard mirror is relaxed-read only; the semaphore is the single source of truth for the limit.

## Security

- The dashboard has **no auth** and binds to `0.0.0.0:9090` by default. Put it behind a reverse proxy if it faces any untrusted network.
- Gateway authentication is pure pass-through. umans-gate does not read, store, or validate API keys. It forwards the `Authorization` header to the upstream provider exactly as received.
- Requests are sent over HTTPS using rustls with the system's web PKI roots.
- The proxy binds to `0.0.0.0:8080` by default. Restrict that interface to trusted clients or place the gateway behind a network firewall.

## Development

Build a release binary:

```bash
cargo build --release
```

Run the test suite:

```bash
cargo test --workspace --features hot-reload
```

Run the strict lint set:

```bash
cargo clippy --workspace -- -D warnings
```

## License

umans-gate is licensed under the MIT OR Apache-2.0 license.
