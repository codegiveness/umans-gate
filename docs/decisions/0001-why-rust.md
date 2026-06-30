# 1. Why Rust

## Context

umans-gate is an API gateway that proxies requests to AI providers. It must keep strict per-provider concurrency limits, stream Server-Sent Events (SSE) without buffering, run a live web dashboard, and ship as a single self-contained binary. The language choice affects performance, correctness, deployment size, and long-term maintenance.

We considered:

- **Go**: fast compilation, easy concurrency, large ecosystem, but lacks the same static ownership guarantees and requires runtime garbage collection that can introduce latency spikes.
- **Rust**: zero-cost abstractions, fearless concurrency via ownership, strong async runtime (tokio), and small native binaries.
- **Python**: productive for prototypes, but too slow for a request-forwarding hot path and harder to ship as one binary.
- **TypeScript/Node.js**: familiar web stack, but GC pauses and larger memory use make it a poor fit for a latency-sensitive gateway.

## Decision

We will build umans-gate in Rust.

## Consequences

- Memory safety is enforced at compile time, reducing a major class of security and stability bugs.
- Async I/O uses tokio, matching the shape of long-lived SSE streams and many concurrent client connections.
- Release binaries are small and self-contained, which simplifies installation on Linux, macOS, and Windows.
- The developer onboarding curve is steeper than Go or Python; we mitigate this with clear internal documentation and focused modules.
- Unsafe code is forbidden at the workspace level via `[workspace.lints.rust] unsafe_code = "forbid"`.

## Status: Accepted
