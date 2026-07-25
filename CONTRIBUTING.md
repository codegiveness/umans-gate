# Contributing to umans-gate

This is a personal-use project. Contributions are welcome but not expected —
this is not an open-source product with a community roadmap. If you find a bug
or want to add a feature for your own use, fork it. If you want to share a
fix or improvement, pull requests are reviewed on a best-effort basis.

## Development setup

```bash
git clone https://github.com/codegiveness/umans-gate.git
cd umans-gate
bun install                          # install root dependencies
cd dashboard && bun install && cd ..  # install dashboard dependencies
```

## Project structure

```
umans-gate/
├── src/          # TypeScript server (proxy, db, ws, viewer, stamp, limiter, vision, workers)
├── dashboard/    # React + Vite + Tailwind + shadcn/ui frontend
├── test/         # bun:test test suite
├── docs/         # additional documentation
└── dist/         # build output (gitignored)
```

## Development workflow

```bash
bun run dev             # start the proxy server (src/cli.ts)
bun run typecheck       # TypeScript type checking
bun run lint            # Biome lint
bun run lint:fix        # Biome lint + auto-fix
bun run test            # run server tests (bun:test)
bun run test:dashboard  # run dashboard tests (vitest + jsdom)
bun run test:all        # run server tests, then dashboard tests
bun run build           # build server (tsup) + dashboard (vite)
```

## Making changes

1. Create a branch from `master`
2. Make your changes — keep the design intent intact
3. Run `bun run typecheck && bun run lint && bun run test:all`
4. If you changed the dashboard, verify it builds: `cd dashboard && bun run build`
5. Open a pull request with a clear description

## Code style

- TypeScript with strict mode
- Biome for formatting and linting (2-space indent, double quotes, semicolons)
- ESM-only — imports use `.js` extensions in `src/` (Bun resolves `.ts` files)
- No `any` types — use proper types
- No `@ts-ignore` or `as any` suppression

## SOLID principles

Every code change should keep the codebase aligned with SOLID principles:

- **Single Responsibility**: each module has exactly one reason to change
  (e.g., `stamp.ts` only handles TTL stamping, `db.ts` only persists captures)
- **Open/Closed**: add new behaviors by introducing new modules or strategies
  rather than editing existing ones; use discriminated unions for variants
- **Liskov Substitution**: specialized implementations honor the same contract
  as the abstraction they replace; prefer composition over inheritance
- **Interface Segregation**: keep interfaces small and role-specific (e.g., a
  `CaptureStore` for persistence, a `Broadcaster` for WebSocket updates)
- **Dependency Inversion**: inject dependencies (config, stores, broadcasters,
  loggers) rather than constructing them inside business logic

## Testing

Tests use `bun:test`. Run the full suite:

```bash
bun run test:all    # runs server tests, then dashboard tests
```

Server tests:

```bash
bun run test                          # run all server tests
bun test test/specific-file.test.ts   # run a specific test file
```

Dashboard tests:

```bash
bun run test:dashboard                # vitest + jsdom in dashboard/
bun run test:dashboard:watch          # watch mode
```

Tests that spawn the proxy server use a mock upstream (see `test/helpers/`).

## Quality checklist

Before finalizing any change, verify:

- [ ] `bun run typecheck` passes with no errors
- [ ] `bun run lint` passes with no new warnings
- [ ] No `as any`, `@ts-ignore`, or `@ts-expect-error` introduced
- [ ] `bun run test:all` passes
- [ ] New behavior has covering tests that fail before the fix/feature
- [ ] Existing tests still pass
- [ ] The diff is minimal and focused on the stated goal
- [ ] Every changed line traces back to the stated goal
- [ ] No unrelated formatting, refactoring, or dead code included

## Dashboard development

```bash
cd dashboard
bun run dev    # Vite dev server at localhost:5173
bun run build  # production build to dashboard/dist/
```

The dashboard talks to the backend's REST API and WebSocket, both under `/dashboard/`.

## Releasing

Releases are automated through `scripts/release.sh`, which bumps the
version, syncs it across all files, updates docs, commits, tags, and
pushes. The tag push triggers `.github/workflows/release.yml`, which
runs pre-release validation then creates the GitHub Release, builds
standalone binaries (6 platforms), and publishes to npm with provenance.

### Automated version sync

`package.json` is the single source of truth for the version. The
release script and CI workflows keep these files in sync automatically:

- `dashboard/package.json` — synced via `scripts/sync-version.ts --sync`
- `CHANGELOG.md` — must have a `## [<version>]` section
- `ROADMAP.md` — "Applies to" stamp updated via `scripts/update-docs.ts --update`
- `docs/README.md` — version + date stamp regenerated on every release

No manual version editing needed — just run the release script.

### Release process

```bash
# 1. Ensure CHANGELOG.md has notes under [Unreleased]
# 2. Run the release helper (handles everything else)
bun run release              # patch: 0.3.19 → 0.3.20
bun run release minor        # minor:  0.3.19 → 0.4.0
bun run release major        # major:  0.3.19 → 1.0.0
bun run release 0.4.2        # explicit version
```

The script:

1. Runs pre-flight checks (typecheck, lint, test, build)
2. Bumps `package.json` version
3. Syncs `dashboard/package.json` to match
4. Updates `ROADMAP.md` stamps + regenerates `docs/README.md` index
5. Validates `CHANGELOG.md` has a section for the new version
6. Commits + tags + pushes (triggers `release.yml`)

### CI gates

Two workflows enforce integrity:

- **`version-check.yml`** — runs on every PR/push touching version-related
  files. Validates consistency (package.json ↔ dashboard/package.json ↔
  CHANGELOG ↔ ROADMAP) and checks all doc links resolve. Fails the PR if
  anything is off.
- **`release.yml`** — on tag push, runs a pre-release validation job
  *before* building/publishing. Fails fast if version is inconsistent or
  CHANGELOG is empty.

### Manual checks (if needed)

```bash
bun run scripts/sync-version.ts          # validate consistency
bun run scripts/sync-version.ts --sync    # fix dashboard/package.json
bun run scripts/update-docs.ts            # validate doc links
bun run scripts/update-docs.ts --update   # update ROADMAP + docs index
```

### Release checklist (for reference)

1. [ ] `bun run typecheck` passes
2. [ ] `bun run test:all` passes
3. [ ] `bun run build` produces `dist/` and `dashboard/dist/`
4. [ ] `bun dist/cli.js` starts and serves the dashboard
5. [ ] `CHANGELOG.md` has notes under `[Unreleased]`
6. [ ] `bun run release` completes without errors
