# Roadmap

This document outlines the planned direction for umans-gate. It is a living
document — priorities may shift based on community feedback and upstream API
changes.

## Current State (v0.1.0)

- ✅ Capture proxy with SQLite storage and WAL mode
- ✅ Anthropic `cache_control` TTL stamping via unified stamp pipeline
- ✅ Vision handoff pipeline (image → text description)
- ✅ Concurrency gate (semaphore + circuit breaker)
- ✅ Sliding-window rate limiter
- ✅ Connection warmer
- ✅ Usage tracking and reconciliation
- ✅ zstd body compression
- ✅ Worker-based capture pipeline
- ✅ Live inspector dashboard (React + shadcn/ui)
- ✅ Dashboard config validation with hot-reload

## Near-Term (v0.2.x)

### Dashboard enhancements
- Capture search and filtering by model, route, status code, and time range
- Economics dashboard: aggregate token costs with charts
- Concurrency gate visualization: live active/queued/breaker state
- Vision description viewer: inspect cached descriptions and hit rates

### Observability
- Prometheus metrics endpoint
- Structured logging with configurable log levels
- Request tracing with correlation IDs across vision/main pipelines

### Testing
- Increase test coverage for vision handoff edge cases
- Integration tests for concurrency gate under load
- Dashboard component tests for config validation UI

## Mid-Term (v0.3.x – v0.4.x)

### Multi-upstream support
- Route requests to different upstream targets based on model or header
- Per-upstream concurrency gates and rate limiters
- Failover between upstream targets

### Capture export
- Export captures as JSONL or HAR format
- Replay captures against a different upstream
- Diff captures to compare model responses

### Performance
- Connection pooling tuning with benchmarks
- Streaming response caching for identical requests
- Configurable capture sampling (capture every Nth request)

## Long-Term (v0.5+)

### Plugin system
- Pluggable stamp strategies via a strategy registry
- Custom capture transformers (redact, augment, tag)
- Middleware hooks for pre-forward and post-capture

### Multi-tenant
- API key-based tenant isolation
- Per-tenant capture retention and rate limits
- Tenant-scoped dashboard views

### Distributed mode
- Shared capture store (PostgreSQL backend)
- Distributed concurrency coordination
- Cluster-aware circuit breaker

## How to Influence This Roadmap

- Open a [GitHub issue](https://github.com/umans-ai/umans-gate/issues) with the
  `enhancement` label
- Start a [discussion](https://github.com/umans-ai/umans-gate/discussions) for
  larger proposals
- Submit a PR — we welcome prototypes and proofs of concept
