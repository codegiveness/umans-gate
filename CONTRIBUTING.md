# Contributing to umans-gate

Thank you for your interest in contributing! This guide covers the basics.

## Development setup

```bash
git clone https://github.com/umans-ai/umans-gate.git
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

1. Create a branch from `main`
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

See [AGENTS.md](AGENTS.md) for detailed SOLID guidance with examples.

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

Releases are triggered by pushing a `v*` tag. The publish workflow handles npm publishing with provenance.

Release checklist:

1. [ ] `bun run typecheck` passes
2. [ ] `bun run test:all` passes
3. [ ] `bun run build` produces `dist/` and `dashboard/dist/`
4. [ ] `bun dist/cli.js` starts and serves the dashboard
5. [ ] Version bumped in `package.json`
6. [ ] `CHANGELOG.md` updated
