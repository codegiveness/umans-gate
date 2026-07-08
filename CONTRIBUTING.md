# Contributing to umans-gate

Thank you for your interest in contributing! This guide covers the basics.

## Development setup

```bash
git clone https://github.com/umans-ai/umans-gate.git
cd umans-gate
bun install          # install root dependencies
cd dashboard && bun install && cd ..  # install dashboard dependencies
```

## Project structure

```
umans-gate/
├── src/          # TypeScript server (proxy, db, ws, viewer, stamp)
├── dashboard/    # React + Vite + Tailwind + shadcn/ui frontend
├── test/         # bun:test test suite
├── public/       # legacy vanilla JS dashboard (kept for reference)
└── dist/         # build output (gitignored)
```

## Development workflow

```bash
bun run dev          # start the proxy server (src/cli.ts)
bun run typecheck    # TypeScript type checking
bun run lint         # Biome lint
bun run lint:fix     # Biome lint + auto-fix
bun run test         # run tests
bun run build        # build server (tsup) + dashboard (vite)
```

## Making changes

1. Create a branch from `main`
2. Make your changes — keep the design intent intact
3. Run `bun run typecheck && bun run lint && bun test`
4. If you changed the dashboard, verify it builds: `cd dashboard && bun run build`
5. Open a pull request with a clear description

## Code style

- TypeScript with strict mode
- Biome for formatting and linting (2-space indent, double quotes, semicolons)
- No `any` types — use proper types
- No `@ts-ignore` or `as any` suppression

## Testing

Tests use `bun:test`. Run the full suite:

```bash
bun test
```

Tests that spawn the proxy server use a mock upstream (see `test/helpers/`).

## Dashboard development

```bash
cd dashboard
bun run dev    # Vite dev server at localhost:5173
bun run build  # production build to dashboard/dist/
```

The dashboard talks to the backend's REST API and WebSocket, both under `/dashboard/`.

## Releasing

Releases are triggered by pushing a `v*` tag. The publish workflow handles npm publishing with provenance.
