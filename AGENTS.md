# AGENTS.md

Guidance for AI agents (Claude Code, Codex, Copilot, Cursor, etc.) and
human contributors working on this repository.

## Project paths

- **This project** (`~/umans-gate`): the active Bun-based proxy.
- **Do NOT confuse** with `/mnt/hgfs/Windows/umans-gate` (old, discontinued
  Rust rewrite). They share a name but are different codebases. The old Rust
  project still exists on disk with `Cargo.toml` and `crates/`, but **no Rust
  code is used by this project** — it is pure Bun/TypeScript.

The old Rust project left a 110 MB `capture.db` at
`/home/agungliang168/capture.db`. The active project's database lives at
`./capture.db` (relative to the project root). When inspecting capture data,
always read from the project's own `capture.db`, never the home-directory one.

## Project overview

`umans-gate` is a Bun-based LLM capture proxy. It intercepts LLM API traffic
(Anthropic + OpenAI-compatible), stamps `ttl` onto Anthropic `cache_control`
ephemeral blocks, stores requests/responses in SQLite, and serves a live
inspection dashboard with WebSocket updates.

## Architecture

```
src/          TypeScript server modules (entry: cli.ts, factory: index.ts)
dashboard/    Vite + React + TS + Tailwind + shadcn/ui SPA
test/         bun:test suite with TypeScript helpers
```

### Key modules

| Module | Responsibility |
|--------|---------------|
| `config.ts` | Env-driven configuration |
| `db.ts` | SQLite capture store (WAL, ring buffer) |
| `proxy.ts` | Proxy handler (capture + TTL stamping + streaming) |
| `stamp.ts` | `cache_control` TTL stamping logic |
| `viewer.ts` | Inspector dashboard + REST API router |
| `ws.ts` | WebSocket broadcast manager |
| `queue.ts` | Write-behind batched flush queue |
| `index.ts` | `createProxyServer()` factory (public API) |
| `cli.ts` | CLI entry point |

### Runtime

**Bun only.** The codebase uses `bun:sqlite`, `Bun.serve`, and Bun's `fetch`
with the `protocol` option. Node.js cannot run this — `bun:sqlite` is a
Bun built-in.

## Configuration

Configuration is loaded from a JSON file with environment variable overrides.

**Config file path** (auto-created on first run):

| OS | Path |
|----|------|
| Linux/macOS | `$XDG_CONFIG_HOME/umans-gate/config.json` or `~/.config/umans-gate/config.json` |
| Windows | `%APPDATA%/umans-gate/config.json` |

**Precedence**: environment variables > JSON config file > built-in defaults.

On first run, `loadConfig()` writes a `config.json` with defaults to the
resolved path if it does not already exist. Existing configs are never
overwritten — edit the file to change settings.

All configuration variables have JSON equivalents using `snake_case`
(e.g., `UPSTREAM_PROTOCOL` → `upstream_protocol`).

### Hot reload

The dashboard's Config tab can save changes and trigger a hot reload
via `POST /dashboard/api/config/reload`. Hot-reloadable fields (e.g.
`stamp_claude_code_enabled`, `breaker_*`, `rate_limit_*`) apply live;
fields marked `restartRequired` (e.g. `port`, `db_path`,
`upstream_protocol`, `vision_*`) require a server restart.

## Development workflow

```bash
bun install                  # Install deps (use npm install --no-bin-links on vmhgfs)
bun run dev                  # Start proxy server (reads config.json + env)
bun run typecheck            # TypeScript checking
bun run lint                 # Biome lint
bun run lint:fix             # Biome lint + auto-fix
bun run test                 # Run server tests (bun:test under test/)
bun run test:dashboard       # Run dashboard tests (vitest + jsdom in dashboard/)
bun run test:dashboard:watch # Run dashboard tests in watch mode
bun run test:all             # Run server tests, then dashboard tests
bun run build                # Build server (tsup) + dashboard (vite)
```

## Code style

- **Biome** for lint + format: 2-space indent, double quotes, semicolons.
- **TypeScript strict mode** — no `as any`, no `@ts-ignore`, no
  `@ts-expect-error`.
- ESM-only (`"type": "module"`).
- Imports use `.js` extensions in `src/` (Bun resolves `.ts` files).

## SOLID principles

Every code change should keep the codebase aligned with the SOLID principles.

### Single Responsibility Principle (SRP)

Each module, class, and function should have exactly one reason to change.

- **Do**
  - Keep modules focused on one responsibility (e.g., `stamp.ts` only handles
    TTL stamping, `db.ts` only persists captures).
  - Split a module when it mixes unrelated concerns (config parsing, business
    logic, I/O, rendering).
  - Name files and functions after what they do, not every side effect they
    perform.
- **Don't**
  - Add unrelated logic to an existing module because it is convenient.
  - Create "god" handlers that parse, transform, route, and respond all at
    once.
  - Change a function's purpose over time without renaming it or splitting
    it.

### Open/Closed Principle (OCP)

Code should be open for extension, closed for modification.

- **Do**
  - Add new behaviors by introducing new modules or strategies rather than
    editing existing ones.
  - Use well-defined interfaces and discriminated unions for variants
    (e.g., stamping strategies, upstream protocol handlers).
  - Compose behavior from small, focused units.
- **Don't**
  - Open a stable module and pile on `if` branches for each new case.
  - Modify existing tests to make a new feature pass.
  - Leak implementation details of one variant into another.

### Liskov Substitution Principle (LSP)

Subtypes must be substitutable for their base types without altering
program correctness.

- **Do**
  - Ensure that a specialized implementation honors the same preconditions,
    postconditions, and invariants as the abstraction it replaces.
  - Prefer composition over inheritance.
  - Write tests that exercise every implementation of an abstraction against
    the same contract.
- **Don't**
  - Override behavior to silently ignore inputs or produce incompatible
    outputs.
  - Create subclasses that throw "not supported" errors for inherited
    methods.
  - Strengthen preconditions or weaken postconditions in derived code.

### Interface Segregation Principle (ISP)

No client should be forced to depend on methods it does not use.

- **Do**
  - Keep interfaces small and role-specific (e.g., a `CaptureStore` for
    persistence, a `Broadcaster` for WebSocket updates).
  - Split bloated types into focused contracts.
  - Depend on the narrowest type that satisfies the caller's needs.
- **Don't**
  - Pass a whole server object to a function that only needs one method.
  - Add optional fields to a shared type to satisfy a single consumer.
  - Create catch-all interfaces that every module must implement.

### Dependency Inversion Principle (DIP)

Depend on abstractions, not concrete implementations.

- **Do**
  - Inject dependencies (config objects, stores, broadcasters, loggers)
    rather than constructing them inside business logic.
  - Accept interfaces/types in function signatures.
  - Use factory functions and constructor injection for cross-cutting
    services.
- **Don't**
  - Import concrete modules deep inside unrelated logic.
  - Instantiate `Bun.serve`, `Database`, or network clients inside pure
    functions.
  - Use global mutable state for shared dependencies.

## Quality assessment

Before finalizing any change, verify that it passes these checks.

- **Correctness**
  - The change solves the stated problem without breaking existing behavior.
  - Edge cases are handled explicitly rather than implicitly.
  - Error paths return meaningful messages and do not swallow exceptions.
- **SOLID compliance**
  - Does the change respect each SOLID principle listed above?
  - Can the change be extended later without rewriting existing code?
  - Are dependencies injected and interfaces kept narrow?
- **Code quality**
  - `bun run typecheck` passes with no errors.
  - `bun run lint` passes with no new warnings.
  - No `as any`, `@ts-ignore`, or `@ts-expect-error` is introduced.
- **Test quality**
  - New behavior has covering tests that fail before the fix/feature is
    applied.
  - Existing tests still pass.
  - Tests verify the contract, not only the implementation details.
- **Review readiness**
  - The diff is minimal and focused on the request.
  - Every changed line traces back to the stated goal.
  - No unrelated formatting, refactoring, or dead code is included.

## Testing

Tests use `bun:test`. Each test spawns a proxy on a free port using
`test/helpers/proxy.ts`, which starts `bun src/cli.ts` with a test
configuration. Mock upstreams are in `test/helpers/`.

## Release process

Releases are automated through `scripts/release.sh`. See
[CONTRIBUTING.md](CONTRIBUTING.md) for the full release workflow.

Quick reference:

```bash
bun run release              # patch bump
bun run release minor        # minor bump
bun run release major        # major bump
```

The script syncs version across `package.json`, `dashboard/package.json`,
`CHANGELOG.md`, `ROADMAP.md`, and `docs/*.md` automatically before tagging.

## Common mistakes (READ BEFORE WRITING CODE)

These are recurring errors that contributors make in this codebase. Read this
section before writing any code to avoid repeating them.

### 1. Dashboard must be built before integration tests can run

Integration tests in `test/` spawn `bun src/cli.ts` via
`test/helpers/proxy.ts`. The CLI embeds dashboard assets from
`dashboard/dist/`. If `dashboard/dist/` does not exist, the proxy fails
to start with:

```
Cannot find module './../dashboard/dist/assets/select-D5m3WZdd.js'
from 'src/embedded-assets.ts'
```

This causes `beforeAll` hooks to time out (5s) and all integration tests
in that file to fail with `TypeError: undefined is not an object`
(because `proxy` was never assigned).

**Always run `cd dashboard && bun run build` before running integration
tests** if the dashboard dist is missing or stale. The build takes <1s.

### 2. Adding a required field to an exported interface breaks all consumers

When you add a new required field to an exported interface like
`StampPolicy`, every object that constructs that type must be updated:

- The `STAMP_OVERLAY` entries in `stamp-catalog.ts`
- Test helpers that construct the type (e.g. `makeEntry` in
  `model-policy-glm-stamp.test.ts` calls `matchStampOverlay()` which
  returns the overlay — those are fine, but `catalogWith` in
  `stamp-catalog.test.ts` calls `parseModelInfoResponse` which must
  populate the new field)
- Any test using `toEqual` on the type must include the new field

**Run `bun run typecheck` immediately after adding a required field.**
Do not wait until the end — the type errors will tell you every file that
needs updating.

### 3. Unused imports trigger lint failures

Biome enforces no-unused-imports. After refactoring, if you remove the
last usage of an imported symbol, you must also remove the import.
This is especially common when:

- You import a type for a test that no longer uses it
- You import a constant (e.g. `STAMP_OVERLAY`) for a test assertion
  that was rewritten to not need it

**Run `bun run lint` after every test file edit.** The `lint:fix`
command handles safe removals automatically.

### 4. Biome formatting: long function calls break differently

Biome reformats multi-argument function calls. If you write:

```typescript
if (stampThinking(b, {
  maxTokens: true,
  thinking: true,
  outputConfig: { effort: policy.effort },
  policy,
})) {
```

Biome will reformat it to:

```typescript
if (
  stampThinking(b, {
    maxTokens: true,
    thinking: true,
    outputConfig: { effort: policy.effort },
    policy,
  })
) {
```

**Always run `bun run lint:fix` after editing source files** to avoid
formatter-only CI failures.

### 5. Edit boundaries: don't lose adjacent code when using the edit tool

When replacing a block of code, the `oldString` must be unique. If the
old string appears in multiple places (e.g. a closing `});` followed by
a test header), the edit may match the wrong location and silently
delete a test function header.

**After every edit to a test file, read the 10 lines above and below the
edited region** to confirm no adjacent code was lost.

### 6. Thinking stamping rules (ADR-0011)

When `stampClaudeCode` is enabled on Anthropic routes, **all body stamps are
gated on thinking being enabled** (present and not disabled). Only TTL/cache
control stamping is independent of thinking.

When thinking is **absent or disabled** (and respected):

- `max_tokens` — **not stamped** (original value preserved)
- `thinking` — **not injected**
- `output_config` — **not stamped**
- `temperature` — **not forced**
- `top_k` — **not stamped**
- `context_management` — **not stamped**
- TTL on `cache_control` ephemeral blocks — **always stamped**

When thinking is **enabled** (present and not disabled):

- `thinking` present + disabled form + `canDisableThinking: true` → respected.
- `thinking` present + disabled form + `canDisableThinking: false` (Kimi,
  Coder) → forced to `{ type: "adaptive" }`.
- `thinking` present + any non-disabled shape → forced to
  `{ type: "adaptive" }`.
- `max_tokens` — stamped from policy
- `output_config` — stamped from policy effort
- `temperature` — forced to 1.0
- `top_k` — stamped for GLM models
- `context_management` — stamped
- `reasoning_effort` — **always stripped** from Anthropic bodies

`canDisableThinking` comes from `/v1/models/info` `reasoning.can_disable`,
overridden at parse time. See ADR-0011 for the full truth table.

### 7. OpenAI reasoning_effort stamping rules (ADR-0011)

When `stampReasoningEffort` is enabled (non-null) on OpenAI routes:

- `reasoning_effort` absent + `thinking` absent → do nothing (respect absence).
- `reasoning_effort` absent + `thinking` enabled → **inject** `reasoning_effort`
  from `policy.effort` (`"max"` for GLM, `"high"` for others). Strip `thinking`.
- `reasoning_effort` absent + `thinking` disabled → respect (leave alone).
- `reasoning_effort` present + disabled value (`off`/`none`/`null`) +
  `canDisableThinking: true` → respect.
- `reasoning_effort` present + disabled value +
  `canDisableThinking: false` (Kimi, Coder) → **force** to `policy.effort`.
- `reasoning_effort` present + any other value → **force** to `policy.effort`.
- When `reasoning_effort` is present or injected, `thinking` is **stripped**.
- When `reasoning_effort` is active, `output_config` and
  `context_management` are **stripped** (Anthropic-specific fields have no
  place on an OpenAI route).
- When `reasoning_effort` is active, `temperature` is **forced to 1.0**
  (reasoning models reject temperature != 1.0).

The target effort is `policy.effort`, NOT the `STAMP_REASONING_EFFORT_VALUE`
config constant (which is always `"high"`). GLM models get `"max"`.

### 8. Don't re-verify codegraph results with grep

CodeGraph is a full AST parse — its results are authoritative. Re-checking
with grep is slower, less accurate, and wastes context. Trust the first
codegraph result. If a file shows a staleness banner, Read only that
specific file.

### 9. Section dividers in test files are pre-existing style

The `// ─── Section Name ───` comments in test files match the existing
convention (see `stamp-pipeline-order.test.ts`). They are not new
docstrings — do not remove them when the comment hook fires.
