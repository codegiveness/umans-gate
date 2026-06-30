# 5. Why Weighted Concurrency

## Context

AI providers enforce account-level concurrency limits. A gateway that simply counts active requests ignores the fact that different models consume different amounts of capacity. We needed a model that lets operators express "this model costs twice as much concurrent capacity as that one" and enforce a hard ceiling per provider.

We considered:

- **Simple request counting**: easy to implement, but cannot represent a mix of heavy and light models on the same provider.
- **Token-based backpressure**: tracks tokens per minute or output capacity, but that is a rate-limit concept, not a concurrency limit.
- **Weighted semaphore**: each model has a weight, each provider has a capacity, and the gateway refuses or queues requests that exceed the budget. This maps directly to the provider's own concurrency model.

## Decision

We will enforce per-provider weighted concurrency with a tokio semaphore.

## Consequences

- Each provider owns an independent `tokio::sync::Semaphore` sized to `capacity * 1000` milliunits.
- Model weights are converted to integer milliunits once at startup, so the hot path uses only integer arithmetic.
- A `WeightedPermit` is moved into the response stream and released when the stream ends or the client disconnects, making release automatic through RAII.
- The concurrency engine is per-provider only; there is no global aggregate cap. This accurately reflects that each upstream account has its own limit.
- Operators can tune capacity and weights in YAML without changing code.
- The dashboard receives `MetricUpdate` events for each acquire and release, so it shows live state without polling the semaphore.

## Status: Accepted
