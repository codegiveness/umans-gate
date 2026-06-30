# 2. Why Axum

## Context

The gateway exposes two HTTP servers: the proxy on one port and the dashboard on another. We need typed routing, middleware support, async handlers, and a way to integrate with our tokio runtime. The web framework choice shapes how handlers compose, how state is shared, and how easily we can add timeouts or concurrency limits.

We considered:

- **Axum**: tokio-native, uses tower for middleware, extracts path and state via type-safe parameters, and streams responses naturally.
- **Actix-web**: mature and fast, but uses its own actor system and runtime model, which diverges from our tokio-first design.
- **Rocket**: ergonomic, but historically required a nightly compiler and a different async mental model.
- **Warp**: filter-based and powerful, but route composition can become hard to read for teams new to the library.

## Decision

We will use axum for all HTTP serving.

## Consequences

- Handlers, middleware, and the concurrency layer all live in the same tokio runtime with no runtime bridging.
- `tower` layers integrate cleanly, so the concurrency limiter and timeout layer can be inserted as Tower services around the route tree.
- Route definitions use standard Rust types via `Path`, `State`, and custom extractors, catching mistakes at compile time.
- The ecosystem around axum, hyper, and tower is the same one used by our upstream HTTP client, so skills and debugging tools transfer across the codebase.
- Because axum is relatively young, we pin a known-good version and review upstream changelogs before upgrading.

## Status: Accepted
