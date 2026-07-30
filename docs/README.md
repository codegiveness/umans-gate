# umans-gate Documentation

> **Current version:** v0.5.10 · **Index updated:** 2026-07-30

umans-gate documentation covers installation, architecture, operations, and development for the Bun-based LLM API capture proxy. Start with [README.md](../README.md) for install and quick start, then read [ARCHITECTURE.md](ARCHITECTURE.md) for system design. Operations and troubleshooting guides cover day-to-day usage. Reference docs document each dashboard tab.

## Start here

- [README.md](../README.md) — install, quick start, full config reference, usage rights
- [PRODUCT.md](PRODUCT.md) — what this project is and who it's for

## Understand the system

- [ARCHITECTURE.md](ARCHITECTURE.md) — system design, data flow, stamp pipeline, concurrency gate
- [proxy-modifications.md](proxy-modifications.md) — every modification the proxy applies to traffic
- [TRANSPARENCY.md](TRANSPARENCY.md) — every endpoint the app contacts, where your API key goes, what it never does

## Operate it

- [OPERATIONS.md](OPERATIONS.md) — day-to-day operations: start/stop, upgrades, health checks, backup
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — common issues and solutions
- [BENCHMARKS.md](BENCHMARKS.md) — performance characteristics and benchmark results

## Develop and extend

- [CONTRIBUTING.md](../CONTRIBUTING.md) — development setup, code style, testing
- [AGENTS.md](../AGENTS.md) — guidance for AI agents working in this codebase
- [SECURITY.md](../SECURITY.md) — vulnerability reporting and security practices
- [ROADMAP.md](../ROADMAP.md) — planned direction

## Reference

- [CHANGELOG.md](../CHANGELOG.md) — version history
- [what-work-with-umans.md](what-work-with-umans.md) — feature mappings to umans-open-stack playbooks
- [Dashboard Design System](../dashboard/DESIGN.md) — design tokens and component guidelines
- Per-tab reference:
  - [captures.md](reference/captures.md) — Captures tab
  - [config.md](reference/config.md) — Config tab
  - [economics.md](reference/economics.md) — Economics tab
  - [models.md](reference/models.md) — Models tab
  - [performance.md](reference/performance.md) — Performance tab
  - [usage.md](reference/usage.md) — Usage tab
  - [vision.md](reference/vision.md) — Vision Calls tab
