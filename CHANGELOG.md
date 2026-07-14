# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- **Docs overhaul**: rewrote README for npm-first "setup and forget" experience.
  Quick Start now leads with `npx umans-gate` / `npm install -g umans-gate`.
  Added platform support table, updating/uninstall sections, and cross-reference
  to [umans-open-stack](https://github.com/umans-ai/umans-open-stack).
- **Stale URLs**: fixed all `umans-ai/umans-gate` → `codegiveness/umans-gate`
  references across package.json, CONTRIBUTING, ROADMAP, CODE_OF_CONDUCT,
  SECURITY, TROUBLESHOOTING, and issue templates.
- **Stale `install.sh` reference**: removed nonexistent curl install script
  from `src/updater.ts`; replaced with `npm install -g umans-gate@latest`.
- **CODEOWNERS**: uncommented catch-all rule (`* @codegiveness`) — file was
  entirely commented out, providing no enforcement.
- **SECURITY.md**: reworded branch protection from "enabled" (false claim) to
  "should be enabled" with checklist + `gh api` CLI command to configure.
- **`.env.example`**: removed from `.gitignore` and staged — README referenced
  it but it was not tracked by git.
- **README prerequisite**: reworded "Bun required" to clarify npm/npx users
  need no prerequisites; Bun only needed for development from source.
- **Removed `publish.yml`**: duplicate publish workflow would race with
  `release.yml` and publish a broken package (no platform binary shim,
  no `optionalDependencies`). Only `release.yml` remains.

### Added

- **CODEOWNERS** (`.github/CODEOWNERS`) for automated review routing.
- **`publishConfig.provenance`** in `package.json` for npm supply-chain attestation.
- **SECURITY.md** rewritten with: npm supply-chain security section, GitHub
  repository security checklist, disclosure timeline, and contributor checklist.
  Corrected false claim about NPM_TOKEN (workflows use a scoped publish token,
  not OIDC-only auth — migration to trusted publishing documented as target).

### Changed

- **ROADMAP**: updated Current State from v0.1.0 → v0.1.3 with npm distribution,
  self-update, platform binaries, and provenance as completed items. Added
  umans-open-stack cross-reference section.
- **CONTRIBUTING.md / GOVERNANCE.md**: fixed `main` → `master` branch references.
- **PRODUCT.md**: repositioned from "Bun-based" to "npm-installable (powered by Bun)"
  with npm-first success criteria.
- **TROUBLESHOOTING.md**: added npm-first user commands alongside dev commands.
- **bug_report.yml**: added install method field (npm/npx/standalone/source); Bun
  version now conditional on dev-from-source only.
- **ci.yml**: removed stale `main` from branch triggers (only `master` exists).
- **package.json keywords**: expanded from 10 → 18 keywords for npm discoverability
  (added `claude`, `prompt-engineering`, `observability`, `sqlite`, `bun`,
  `developer-tools`, `api-proxy`, `prompt-caching`).
- **ARCHITECTURE.md**: added umans-open-stack cross-reference with
  playbook-to-implementation mapping table.

### Security

- **SECURITY.md**: added account security section — 2FA requirement for npm
  publisher + GitHub org admins, token rotation policy, quarterly access review.

## [0.1.3] - 2026-07-14

### Fixed

- **npm package republish**: v0.1.2 was published via the now-deleted
  `publish.yml` workflow (raw `npm publish` on repo `package.json`), which
  shipped `dist/cli.js` with a `#!/usr/bin/env bun` shebang and `engines: { bun:
  ">=1.1.0" }` — **requiring Bun to run**. This contradicted the "no
  prerequisites" promise. v0.1.3 republishes via `release.yml` which runs
  `scripts/pack-npm.sh` to produce the correct shim-based package (`bin:
  npm-shim.cjs` + 6 platform `optionalDependencies` with pre-compiled
  standalone binaries). `npx umans-gate` now works without Bun installed.
- **ARCHITECTURE.md**: fixed wrong file paths in umans-open-stack mapping table
  (`src/gate.ts` → `src/limiter/gate.ts`, `src/vision.ts` → `src/vision/handoff.ts`).
- **README.md**: removed misleading `.env.example` reference (file only has
  `UMANS_API_KEY=`; reworded to reference config variables generally).
- **README.md**: fixed `vision_*` incorrectly listed as hot-reloadable — moved
  to `restartRequired` (matches `RESTART_REQUIRED_FIELDS` in `src/config.ts`).
- **SECURITY.md**: softened "SLSA Level 3 provenance" to "npm provenance
  attestation" for accuracy and consistency with ROADMAP.md.
- **docs/proxy-modifications.md**: fixed stale "24h TTL" → "7-day TTL" and
  "transcoded to JPEG" → "transcoded to the configured format (PNG/JPEG)".
- **AGENTS.md**: fixed stale config field names `target` (removed from config)
  and `stamp_cache_ttl` (replaced by `stamp_claude_code_enabled`).
- **CHANGELOG.md**: removed duplicate entries between [Unreleased] and [0.1.3].
- **MAINTAINERS.md**: populated template with actual maintainer (`@codegiveness`).
- **Startup banner** (`src/banner.ts`): version is now read from `package.json`
  instead of being hardcoded at `v0.1.0`. Every prior release printed the wrong
  version on startup.
- **`clean` script** (`package.json`): `capture.db` → `umans-gate.db` (3 file
  suffixes). `bun run clean` now correctly removes the actual database.
- **`biome.json`**: `capture.db*` → `umans-gate.db*` (stale entry from DB rename).
- **ARCHITECTURE.md**: fixed ASCII diagram alignment after `capture.db` →
  `umans-gate.db` rename (SQLite box widened to fit text, `┴` connector
  aligned with proxy box `┬` above).
- **Benchmark result files**: untracked 36 stale files across three benchmark
  directories (`benchmark/vision-handoff/results/`, `benchmark/proxy-optimizations/results/`,
  and `benchmark/concurrency-gate/results.json`) — they contained old
  `umans-ai/umans-gate` URLs in vision-test descriptions and a partially-redacted
  API key (`sk-f1qgI...tmJI`). Updated `.gitignore` to also match `results.json`
  files directly in benchmark directories (not just `results/` subdirectories).
- **README badge**: removed misleading "Runtime: Bun" badge (contradicts "No
  prerequisites for npm/npx"). Added CodeQL badge.
- **CI lint failures**: added `src/embedded-assets.ts` to `biome.json` ignore
  list (generated file with long import lines that Biome wanted to reformat).
  Auto-fixed `package.json` `files` array formatting (Biome wanted inline).
  These two pre-existing lint errors caused ALL CI runs and ALL Dependabot PRs
  to fail.
- **Release workflow resilience**: `release.yml` now retries each npm publish
  step 3 times with 15s delays. Platform package publish failures no longer
  block the main shim from publishing (previously `win32-arm64` spam detection
  failure prevented the entire release).

### Added

- **CodeQL code scanning** (`.github/workflows/codeql.yml`) — weekly automated
  security analysis for JavaScript/TypeScript.

## [0.1.2] - 2026-07-14

### Fixed

- Add `repository.url` and `license` to platform-specific npm packages generated
  by `scripts/pack-npm.sh` to fix npm provenance publishing (E422 rejection).

## [0.1.1] - 2026-07-14

### Fixed

- Fix `repository.url` in `package.json` to point to `codegiveness/umans-gate`
  (was `umans-ai/umans-gate` — npm page linked to wrong repo).

## [0.1.0] - 2026-07-10

### Added

- **Vision handoff pipeline**: replaces image blocks with text descriptions
  generated by a separate vision model (`umans-flash`). Images are transcoded
  to JPEG/PNG, sent to the vision model, and descriptions are cached (7-day TTL)
  with persistent storage. Strategies: `always`, `catalog`, `never`.
  - Modules: `src/vision/` (`handoff.ts`, `detect.ts`, `cache.ts`,
    `persistent-cache.ts`, `transcode.ts`, `wrapper.ts`, `sink.ts`)
  - `src/vision-description-store.ts` — persistent description storage in SQLite
- **Concurrency gate** (`src/limiter/`): semaphore + circuit breaker with
  intention-based reservations (main vs vision), hard cap, soft limit driven by
  `/v1/usage`, queue timeout, and over-subscription fallback.
  - `src/limiter/gate.ts` — `ConcurrencyGate`, `Semaphore`, `CircuitBreaker`
  - `src/limiter/types.ts` — gate option types
- **Rate limiting** (`src/rate.ts`): sliding-window weighted rate limiter for
  pro-tier request limits. Auto-derives from `/v1/usage` or explicit config.
- **Connection warmer** (`src/warmer.ts`): periodic `/v1/models` pings to keep
  TLS warm. Skips when real traffic occurred in the last interval.
- **Usage tracking** (`src/usage.ts`, `src/usage-extract.ts`): fetches and
  reconciles `/v1/usage` data to size concurrency limits, detect rate-boxing,
  and demote priority. Extractors for Anthropic + OpenAI streaming/non-streaming.
- **Economics module** (`src/economics.ts`): token cost calculation per capture.
- **Metrics module** (`src/metrics.ts`): aggregated runtime statistics.
- **Model info parser** (`src/model-info-parser.ts`): parses `/v1/models`
  response to determine vision support per model.
- **Model policy** (`src/model-policy.ts`): model-aware stamping decisions.
- **Compressed capture storage** (`src/compress.ts`): zstd compression for
  request/response bodies (default: on).
- **Worker-based capture pipeline** (`src/workers/`): offload capture writes to
  a worker thread for non-blocking streaming.
- **Stamp pipeline** (`src/stamp-pipeline.ts`): unified stamping orchestrator
  that applies TTL, `top_k`, `max_tokens`, `thinking`, `output_config`,
  `context_management`, and `temperature` stamps in the correct order.
- **Individual stamp modules**:
  - `src/stamp-temperature.ts` — forces `temperature` value
  - `src/stamp-thinking.ts` — injects `thinking`, `max_tokens`, `output_config`
  - `src/stamp-topk.ts` — injects `top_k`
  - `src/stamp-reasoning.ts` — OpenAI-compatible `reasoning_effort` stamping
- **Bundled stamp toggle**: `stamp_claude_code_enabled` replaces individual
  stamp toggles — one switch applies the full Claude Code stamp bundle.
- **Dashboard config validation**: dispatch-table-based validation with
  hot-reload support and restart-required field detection.
- **Dashboard polling consolidation**: `usePollingResource` hook unifies
  triplicated polling logic.
- **WebSocket backpressure management**: configurable limit and auto-close.
- **Upstream timeout** (`upstream_timeout_ms`): configurable fetch timeout.
- **Capture body size limit** (`capture_body_max_bytes`).
- **Logger** (`src/logger.ts`): structured scoped logging replacing `console.*`.
- **Shared utilities** (`src/shared/`): extracted domain helpers for
  model-name parsing, usage fetching, dashboard constants, and vision sink.

### Changed

- **SOLID refactor (Waves 1–5)**: split monolithic modules into focused,
  single-responsibility units. Helpers split into domain modules, `ConcurrencyGate`
  decomposed into `Semaphore` + `CircuitBreaker`, `useCaptures` split into
  `useCaptureList` + `useCaptureDetail` + `useGateStats`, config validation
  replaced if/else chains with dispatch tables.
- **Stamp toggles consolidated**: individual `stamp_cache_ttl_enabled`,
  `stamp_top_k_enabled`, `stamp_max_tokens_enabled`, `stamp_thinking_enabled`,
  `stamp_output_config_enabled` → single `stamp_claude_code_enabled`.
- **Vision strategy default**: `always` → `catalog` (only intercept when model
  lacks vision support).
- **Vision image format default**: `jpeg` → `png` (higher fidelity for OCR).
- **Vision cache TTL default**: 24h → 7 days (`604800000ms`).
- **`max_tokens` stamp values**: GLM models get `131071`, non-GLM get `32767`.
- **Config validation**: now uses dispatch table instead of if/else chains.
- **Dashboard capture detail**: copy-status derived from source state.
- **Usage extraction**: replaced provider×streaming dispatch with `EXTRACTORS`
  lookup table.
- **ConnectionWarmer**: narrowed constructor to `Pick<ProxyConfig, ...>`.

### Fixed

- Streaming `duration_ms` now floors at wall-clock to prevent timing collapse
- Limiter allows permit acquisition when reservations are over-subscribed
- `stamp-reasoning` correctly removes `max_tokens`/`thinking` before injection

## [0.0.1] - 2025-07-02

### Added

- TypeScript rewrite of the capture proxy (modular `src/` structure)
- Vite + React + Tailwind + shadcn/ui dashboard
- `createProxyServer()` programmatic API
- Biome for linting and formatting
- GitHub Actions CI (matrix: ubuntu + macOS, Bun 1.1 + latest)
- npm publish workflow with Sigstore provenance
- Issue templates, PR template, dependabot config
- `.env.example` documenting all environment variables
- MIT license

### Changed

- Single-file `capture.js` → modular TypeScript in `src/`
- Vanilla JS dashboard → React + shadcn/ui dashboard
- Test helpers reference new entry point (no more `proxy.js`/`capture-only.js`)

### Fixed

- Broken tests that spawned non-existent `proxy.js` file
- Runtime artifacts (`capture.db*`) now gitignored
