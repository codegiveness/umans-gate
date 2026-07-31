# AGENTS.md

This file is the contributor and agent guide for the umans-gate repository.

## Project paths

- **This project** (`umans-gate`): a Bun-based LLM capture proxy. Pure
  Bun/TypeScript, no Rust code.
- Database lives at `./umans-gate.db` (project root). Read from this file
  only when inspecting capture data.

## Project overview

`umans-gate` is a Bun-based LLM API capture proxy. It intercepts Anthropic and OpenAI-compatible traffic, stamps `ttl` onto Anthropic `cache_control` ephemeral blocks, stores requests and responses in SQLite, and serves a live inspection dashboard over WebSocket.

## Architecture

```
src/          TypeScript server modules (entry: cli.ts, factory: index.ts)
dashboard/    Vite + React + TS + Tailwind + shadcn/ui SPA
test/         bun:test suite with TypeScript helpers
```

### Key modules

| Module | Responsibility |
|--------|---------------|
| `config.ts` | Env-driven configuration (barrel for `config/`) |
| `db.ts` | SQLite capture store (WAL, ring buffer) |
| `proxy.ts` | Proxy handler (capture + stamping + streaming) |
| `stamp.ts` | `cache_control` TTL stamping logic |
| `stamp-pipeline.ts` | Unified stamp orchestrator |
| `viewer.ts` | Inspector dashboard + REST API router |
| `ws.ts` | WebSocket broadcast manager |
| `queue.ts` | Write-behind batched flush queue |
| `index.ts` | `createProxyServer()` factory (public API) |
| `cli.ts` | CLI entry point |

### Runtime

**Bun only.** Uses `bun:sqlite`, `Bun.serve`, and Bun's `fetch` with the
`protocol` option. Node.js cannot run this because `bun:sqlite` is a Bun built-in.

## Configuration

Configuration is loaded from a JSON file with environment variable overrides.

**Config file path** (auto-created on first run):

| OS | Path |
|----|------|
| Linux/macOS | `$XDG_CONFIG_HOME/umans-gate/config.json` or `~/.config/umans-gate/config.json` |
| Windows | `%APPDATA%/umans-gate/config.json` |

**Precedence:** env vars > JSON config > built-in defaults. On first run,
`loadConfig()` writes defaults if the file doesn't exist. Existing configs
are never overwritten. All env vars have `snake_case` JSON equivalents.

### Full config field table

| Field | Default |
|---|---|
| `port` | `1945` |
| `max_captures` | `200` |
| `db_path` | `./umans-gate.db` |
| `idle_timeout` | `255` |
| `upstream_protocol` | `http1.1` |
| `stamp_claude_code_enabled` | `true` |
| `stamp_model_rules` | `[]` |
| `stamp_reasoning_effort_enabled` | `true` |
| `warmer_enabled` | `true` |
| `warmer_interval_ms` | `20000` |
| `umans_api_key` | `""` |
| `dashboard_token` | `""` |
| `usage_refresh_ms` | `60000` |
| `usage_history_enabled` | `true` |
| `usage_raw_retention_days` | `7` |
| `usage_gap_threshold_minutes` | `60` |
| `usage_idle_session_timeout_minutes` | `5` |
| `models_refresh_ms` | `3600000` |
| `concurrency_hard_cap` | `16` |
| `concurrency_soft_limit` | `8` |
| `use_hard_cap` | `true` |
| `rate_limit_requests` | `0` |
| `queue_timeout_ms` | `180000` |
| `max_queue_depth` | `256` |
| `release_cooldown_ms` | `1000` |
| `breaker_threshold` | `5` |
| `breaker_window_ms` | `300000` |
| `breaker_cooldown_ms` | `60000` |
| `vision_strategy` | `catalog` |
| `vision_model` | `umans-flash` |
| `vision_prompt` | _(long string, see `src/config/defaults.ts`)_ |
| `vision_prompt_version` | `2` |
| `vision_max_images` | `20` |
| `vision_max_description_tokens` | `4096` |
| `vision_reasoning_effort` | `none` |
| `vision_timeout_ms` | `0` |
| `vision_cache_size` | `1000` |
| `vision_cache_ttl_ms` | `604800000` |
| `vision_cache_max_rows` | `10000` |
| `vision_persistent_cache` | `true` |
| `vision_concurrency` | `4` |
| `vision_max_dimension` | `2048` |
| `vision_jpeg_quality` | `92` |
| `vision_image_format` | `png` |
| `vision_image_detail` | `high` |
| `vision_intent_strategy` | `auto` |
| `vision_decomposition_enabled` | `true` |
| `vision_decomposition_timeout_ms` | `3000` |
| `vision_crafting_timeout_ms` | `3000` |
| `vision_adjacent_text_max_chars` | `500` |
| `vision_recent_messages_count` | `6` |
| `vision_system_prompt_max_chars` | `1000` |
| `concurrency_main_reservation` | `1` |
| `concurrency_vision_reservation` | `1` |
| `capture_body_max_bytes` | `10000000` |
| `queue_max_depth` | `100` |
| `ws_backpressure_limit` | `1048576` |
| `ws_close_on_backpressure_limit` | `true` |
| `vision_pending_max_batch` | `50` |
| `compression_enabled` | `true` |
| `upstream_timeout_ms` | `1800000` |
| `experiment_rewrite_ids` | `true` |
| `experiment_rewrite_ttl_ms` | `3600000` |
| `experiment_strip_omo_reminder` | `true` |
| `experiment_ttft_watchdog` | `true` |
| `ttft_timeout_ms` | `60000` |
| `ttft_retry_max_attempts` | `3` |
| `ttft_retry_gate_saturation_pct` | `80` |
| `ttft_retry_cooldown_ms` | `5000` |
| `ttft_watchdog_multiplier` | `5` |
| `ttft_watchdog_hard_cap_ms` | `300000` |
| `performance_sample_count` | `200` |
| `incident_retention_days` | `30` |

### Hot reload

The Config tab can save and hot-reload via
`POST /dashboard/api/config/reload`. **All config fields are hot-reloadable
except those marked `restartRequired`** (e.g. `port`, `max_captures`,
`db_path`, `idle_timeout`, `upstream_protocol`, `queue_max_depth`,
`ws_backpressure_limit`, `ws_close_on_backpressure_limit`, `warmer_*`,
`usage_refresh_ms`, `models_refresh_ms`, `umans_api_key`,
`dashboard_token`, `vision_strategy`, `vision_model`, `vision_prompt`,
`vision_prompt_version`, `vision_max_images`, `vision_max_description_tokens`,
`vision_reasoning_effort`, `vision_timeout_ms`, `vision_cache_size`,
`vision_cache_ttl_ms`, `vision_cache_max_rows`, `vision_persistent_cache`,
`vision_max_dimension`, `vision_jpeg_quality`, `vision_image_format`,
`vision_image_detail`, `vision_concurrency`, `vision_pending_max_batch`).
The full set of hot-reloadable fields is defined in `src/config/reload.ts`
(`RELOAD_FIELDS`); restart-required fields are listed in
`RESTART_REQUIRED_FIELDS` in the same file.

## Development workflow

Run these commands for local development:

```bash
bun install                  # Install deps
bun run dev                  # Start proxy server (reads config.json + env)
bun run typecheck            # TypeScript checking
bun run lint                 # Biome lint
bun run lint:fix             # Biome lint + auto-fix
bun run test                 # Run server tests (bun:test under test/)
bun run test:dashboard       # Run dashboard tests (vitest + jsdom)
bun run test:dashboard:watch # Run dashboard tests in watch mode
bun run test:all             # Run server tests, then dashboard tests
bun run build                # Build server (tsup) + dashboard (vite)
```

## Code style

- **Biome** for lint + format: 2-space indent, double quotes, semicolons.
- **TypeScript strict mode**, no `as any`, no `@ts-ignore`, no
  `@ts-expect-error`.
- ESM-only (`"type": "module"`).
- Imports use `.js` extensions in `src/` (Bun resolves `.ts` files).

## SOLID principles

Every code change should keep the codebase aligned with SOLID.

### Single Responsibility (SRP)

Each module/class/function has exactly one reason to change.

- **Do**: Keep modules focused (`stamp.ts` = TTL stamping, `db.ts` =
  persistence). Split when mixing concerns. Name by what they do.
- **Don't**: Add unrelated logic to a convenient module. Create "god"
  handlers. Change purpose without renaming.

### Open/Closed (OCP)

Open for extension, closed for modification.

- **Do**: Add behaviors via new modules/strategies. Use interfaces and
  discriminated unions. Compose from small units.
- **Don't**: Pile `if` branches onto stable modules. Modify existing tests
  to make a feature pass. Leak implementation details across variants.

### Liskov Substitution (LSP)

Subtypes substitutable for base types without altering correctness.

- **Do**: Honor preconditions/postconditions/invariants. Prefer
  composition. Test every implementation against the same contract.
- **Don't**: Silently ignore inputs or produce incompatible outputs. Throw
  "not supported" for inherited methods. Strengthen preconditions.

### Interface Segregation (ISP)

No client forced to depend on methods it doesn't use.

- **Do**: Keep interfaces small and role-specific (`CaptureStore` for
  persistence, `Broadcaster` for WS). Split bloated types. Depend on the
  narrowest type.
- **Don't**: Pass a whole server to a function needing one method. Add
  optional fields to satisfy a single consumer. Create catch-all interfaces.

### Dependency Inversion (DIP)

Depend on abstractions, not concrete implementations.

- **Do**: Inject dependencies (config, stores, broadcasters, loggers).
  Accept interfaces in signatures. Use factory functions and constructor
  injection.
- **Don't**: Import concrete modules deep inside unrelated logic.
  Instantiate `Bun.serve`, `Database`, or network clients inside pure
  functions. Use global mutable state for shared dependencies.

## Quality assessment

Before finalizing, verify:

- **Correctness**: solves the problem without breaking existing behavior;
  edge cases handled explicitly; error paths return meaningful messages.
- **SOLID compliance**: respects each principle; extensible; dependencies
  injected; interfaces narrow.
- **Code quality**: `bun run typecheck` passes; `bun run lint` passes with
  no new warnings; no `as any`, `@ts-ignore`, `@ts-expect-error`.
- **Test quality**: new behavior has covering tests that fail before the
  fix/feature; existing tests pass; tests verify the contract.
- **Review readiness**: diff is minimal and focused; every changed line
  traces to the goal; no unrelated formatting, refactoring, or dead code.

## Testing

Tests use `bun:test`. Each test spawns a proxy on a free port via
`test/helpers/proxy.ts`, which starts `bun src/cli.ts` with a test config.
Mock upstreams are in `test/helpers/`.

> **Integration tests require the dashboard to be built.** The CLI imports
> `src/embedded-assets.ts`, which references hashed files under
> `dashboard/dist/`. If dist is missing or `embedded-assets.ts` is stale,
> the proxy fails to start with a cryptic "Cannot find module" error and
> `beforeAll` hooks time out. Run `bun run build` (not just
> `cd dashboard && bun run build`) to regenerate both dashboard/dist/ and
> src/embedded-assets.ts. The test harness in `test/helpers/proxy.ts`
> performs a staleness check and fails fast with a clear message if assets
> are missing or older than dist.

## Release process

Releases automated through `scripts/release.sh`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full workflow.

```bash
bun run release              # patch bump
bun run release minor        # minor bump
bun run release major        # major bump
```

The script syncs version across `package.json`, `dashboard/package.json`,
`CHANGELOG.md`, `ROADMAP.md`, and `docs/*.md` before tagging.

## AI agent behavioral rules

AI agents (Claude Code, Codex, Copilot, Cursor) must also read
[`.github/AGENT_RULES.md`](.github/AGENT_RULES.md) before writing code. It
contains the recurring mistakes, thinking stamping rules, and
`reasoning_effort` stamping rules that are easy to get wrong.

## Agent skills

This repo uses the [Matt Pocock engineering skills](https://github.com/mattpocock/skills)
convention for issue tracking, triage, and domain documentation. All
artifacts below are tracked in git and public.

### Issue tracker

Issues and specs live as markdown files under `.scratch/<feature-slug>/`.
See [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md) for the
full conventions (one feature per directory, `spec.md`, numbered issue
files, `Status:` lines, comments under `## Comments`).

### Triage labels

Five canonical roles used as-is. See
[`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).

| Label | Meaning |
|---|---|
| `needs-triage` | Maintainer needs to evaluate this issue |
| `needs-info` | Waiting on reporter for more information |
| `ready-for-agent` | Fully specified, ready for an AFK agent |
| `ready-for-human` | Requires human implementation |
| `wontfix` | Will not be actioned |

### Domain docs

Single context: one `CONTEXT.md` plus `docs/adr/` at the repo root.

**Before exploring, read:**
- `CONTEXT.md` at the repo root (or `CONTEXT-MAP.md` if it exists, which
  points at one `CONTEXT.md` per context).
- `docs/adr/`: read ADRs that touch the area you're about to work in.

If any of these files don't exist, **proceed silently**. Don't flag their
absence; don't suggest creating them upfront.

**ADR file structure:**

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-accept-cache-hit-rate-instability.md
│   └── ...
└── src/
```

**Use the glossary's vocabulary.** When your output names a domain concept
(in an issue title, a refactor proposal, a test name), use the term as
defined in `CONTEXT.md`. Don't drift to synonyms the glossary avoids.

**Flag ADR conflicts.** If your output contradicts an existing ADR, surface
it explicitly rather than silently overriding:

> _Contradicts ADR-0007, but worth reopening because…_
