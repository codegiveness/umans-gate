# ADR-0028: Three-layer test pyramid

**Status:** Accepted
**Date:** 2026-07-29
**Supersedes:** — (replaces the implicit single-layer approach)

## Context

The server test suite has grown to 135 files / 1359 tests with a wall-clock
runtime of **5 minutes 40 seconds**. The root cause is not the number of
tests but the architecture: **59 of 135 files spawn a full OS subprocess**
via `startProxy()`, which `spawn(["bun", "src/cli.ts"])` on a free port,
polls `/health` up to 100 times, then `kill(9)` + `sleep(400)` on teardown.

Each subprocess invocation costs ~1.5–2.5s of pure infrastructure overhead
(port discovery, health polling, process teardown). Across 59 files this is
~120s — over a third of the total runtime — spent on process plumbing, not
test logic. A secondary symptom is resource exhaustion: concurrent temp
SQLite databases cause `disk full` and `SQLite BUSY` failures (5 failures
observed in a clean run).

Meanwhile, `createProxyServer()` — a factory that starts the proxy
in-process on port 0 with injectable `db` and `ws` dependencies — exists in
`src/index.ts` but is **used by zero tests**. Every test goes through the
CLI subprocess path.

The dashboard test suite (32 files / 380 tests / 64s) runs fully serial
(`maxWorkers: 1, fileParallelism: false`) with a 20s per-test timeout,
suggesting test interference under parallelism.

## Decision

Adopt a **three-layer test pyramid** for both server and dashboard tests.

### Server test layers

| Layer | Directory | What | Count target | Runtime target |
|-------|-----------|------|-------------|----------------|
| Unit | `test/unit/` | Pure functions, no I/O — stamp logic, config validation, usage parsing, format helpers | ~60-80 files | <15s |
| Integration | `test/integration/` | `createProxyServer()` on port 0 + mock upstream, real HTTP through `fetch()` | ~40-50 files | <60s |
| E2E | `test/e2e/` | Real CLI `spawn(["bun","src/cli.ts"])` — security boundaries, service lifecycle, dashboard-build guard | ~10-15 files | <60s |

**Target total runtime: ~2 min** (down from 5:40). 90% of tests run
in-process.

### Dashboard test layers

| Layer | What | Count target |
|-------|------|-------------|
| Unit | Pure logic (`gate-health`, `format`, `badge-colors`, `config-validation`) — no React render | ~5-8 files |
| Component | `@testing-library/react` render + interaction | ~25 files |

No e2e layer for dashboard (Playwright is installed but no e2e tests exist).

### In-process harness

Create `test/helpers/in-process-proxy.ts` exporting
`startInProcessProxy(options)` that:

1. Calls `createProxyServer({ config })` — in-process, port 0
2. Returns a **drop-in compatible** shape: `{ port, baseUrl, kill(), ... }`
3. Also exposes `db`, `ws`, `gate`, `models` for tests that need internal state
4. `kill()` calls `server.shutdown()` + cleans temp DB

Migration is a one-line import swap: `startProxy` → `startInProcessProxy`.
Tests don't change assertions; only the import and config key names change
(env var strings → typed config object).

### CI split

```yaml
test-unit:          # bun test test/unit        — ~15s
test-integration:   # bun test test/integration — ~60s
test-e2e:           # bun test test/e2e         — ~60s
test-dashboard:     # vitest (parallel)         — ~20s
```

Four parallel jobs. Unit feedback in 15s. Total wall-clock: ~60s.

### Migration strategy

Stratified rollout — module by module, starting with `stamp-*.test.ts`:

1. Build `startInProcessProxy()` harness
2. Split stamp tests into unit (pure function calls) + integration (in-process HTTP)
3. Verify green, delete old subprocess versions
4. Repeat for `usage-*.test.ts`, `proxy-*.test.ts`, `vision-*.test.ts`, `sec-*.test.ts`
5. Move remaining subprocess tests to `test/e2e/`
6. Restructure dashboard tests + fix parallelism

Each step leaves the suite green. Migration can pause and resume at any point.

### Dashboard parallelism fix

Root cause of serial execution is shared global polyfills in `setup.ts`
(`ResizeObserver`, `console.warn/error` overrides, `showModal` polyfills)
leaking across vitest workers. Fix: move polyfills to per-file `beforeAll`
or use vitest's `environmentOptions` to scope them. Then remove
`maxWorkers: 1, fileParallelism: false`.

## Alternatives considered

1. **Two layers (unit + e2e only)** — rejected. Loses the middle layer where
   most current tests belong (they need "a proxy and an upstream" but not a
   real OS process). Would force HTTP-through-subprocess for all
   integration tests.

2. **Big bang rewrite** — rejected. 59-file diff is unreviewable. If
   something breaks, debugging is near-impossible. Stratified rollout
   keeps the suite green at every step.

3. **Flat directory with naming convention** — rejected. 135 files in one
   flat namespace is already past its breaking point. Layered directories
   give free CI partitioning and self-documenting test placement.

4. **Keep vitest for dashboard** — accepted. Switching to `bun:test` would
   lose the React Testing Library + jsdom ecosystem. The problem isn't the
   runner; it's the serial execution and missing test isolation.

## Consequences

- **Positive:** Runtime drops from 5:40 to ~2:00. Unit feedback in 15s.
  Failure isolation by layer. Test placement is self-documenting.
- **Positive:** `createProxyServer()` finally gets test coverage, which also
  de-risks the public API surface.
- **Negative:** One-time migration effort (~59 files to move/split). Git
  history preserved via `git mv`.
- **Negative:** CI consumes 4 runners instead of 1. Within GitHub free
  tier limits (2000 min/month Linux; ~250 pushes/month to exhaust).
- **Negative:** `startInProcessProxy()` is a new helper that must be
  maintained alongside `startProxy()`. Mitigated by drop-in compatibility
  — the surface is identical.
