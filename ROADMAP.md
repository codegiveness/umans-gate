# Roadmap

> **Applies to:** umans-gate v0.5.0 · **Last updated:** 2026-07-28

umans-gate roadmap: planned direction and likely priorities. Items are not
committed or scheduled. They shift based on upstream API changes and personal
development needs.

## What already exists in v0.4.5

- ✅ Capture proxy with SQLite storage, WAL mode, and zstd body compression
- ✅ Anthropic `cache_control` TTL stamping via unified stamp pipeline
- ✅ Full stamp bundle: TTL, `top_k`, `max_tokens`, `thinking`,
  `output_config`, `context_management`, `temperature`
- ✅ OpenAI-compatible `reasoning_effort` stamping (strips `thinking`/`max_tokens`)
- ✅ Vision handoff pipeline (image → text description, cached 7-day TTL)
- ✅ Intent-aware vision prompting (generic, slotted, crafted, decomposed)
- ✅ Concurrency gate (semaphore + circuit breaker + intention-based reservations)
- ✅ Sliding-window rate limiter (auto-derived from `/v1/usage`)
- ✅ Connection warmer (TLS keep-alive)
- ✅ Usage tracking and reconciliation
- ✅ Worker-based capture pipeline
- ✅ Live inspector dashboard (React + shadcn/ui + WebSocket)
- ✅ Dashboard config validation with hot-reload
- ✅ Body render state-aware (in-flight, done, null body handling)
- ✅ Self-update (`umans-gate update`) and uninstall (`umans-gate uninstall`)
- ✅ Service persistence (systemd / launchd / Windows Service via NSSM)
- ✅ 6 pre-compiled platform binaries (darwin/linux/win32 × arm64/x64)
- ✅ npm-first distribution: `npx umans-gate` / `npm install -g umans-gate`
- ✅ npm provenance attestation on all published packages
- ✅ CodeQL code scanning (weekly + on push/PR)
- ✅ Release automation: version sync, docs update, pre-release validation
- ✅ CI version consistency gate (version-check.yml)
- ✅ Model-specific thinking block shapes (ADR-0017): `umans-glm*` and
  `umans-kimi*`/`umans-coder` force preserved-thinking shapes; other families
  keep `{ type: "adaptive" }`
- ✅ One-click dashboard update without `DASHBOARD_TOKEN` requirement
  (ADR-0015); version info pushed over WebSocket
- ✅ Performance stats: `ttft_max` and `tps_min` alongside mean/percentile
- ✅ Hybrid idle timeout: open sessions count as active even without token
  movement
- ✅ Reference docs reorganized; `.github/AGENT_RULES.md` for AI agent
  behavioral rules

## Near-term priorities

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

## Mid-term possibilities

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

## Long-term possibilities

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

## Related: umans-open-stack

umans-gate implements patterns documented in
[umans-open-stack](https://github.com/umans-ai/umans-open-stack), a curated set of
open source tools and playbooks. Specifically:

- **Concurrency playbook** → umans-gate's concurrency gate (semaphore + circuit breaker)
- **Caching playbook** → `cache_control` TTL stamping pipeline
- **Vision-handoff playbook** → vision description pipeline (image → text → context injection)
- **Workflows playbook** → capture-and-replay architecture

Future roadmap items may be informed by playbooks added to umans-open-stack.

## How to influence this roadmap

This is a personal-use project. The roadmap reflects the maintainer's own
priorities. If you fork the project and want to share a fix or improvement, open
a [GitHub issue](https://github.com/codegiveness/umans-gate/issues) or submit a PR.
It may be reviewed on a best-effort basis.
