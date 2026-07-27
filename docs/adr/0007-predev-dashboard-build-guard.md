# predev guard for dashboard build

A clean checkout or a `bun run clean` run leaves the dashboard (`dashboard/dist/`) and its embedded-asset manifest (`src/embedded-assets.ts`) absent. The server then serves a "dashboard not built" 404 or crashes on module load because `embedded-assets.ts` imports stale hashed filenames that no longer exist.

The proxy added a `predev` npm script that rebuilds the dashboard when missing and always regenerates the embedded-asset manifest:

```json
"predev": "[ -f dashboard/dist/index.html ] || bun run build:dashboard && bun run build:embed-assets"
```

POSIX `||` and `&&` have equal precedence and associate left-to-right, so
this parses as `([ -f index.html ] || bun run build:dashboard) && bun run build:embed-assets`:

- If `index.html` exists: dashboard build is skipped, embed-assets always regenerates (~50ms).
- If `index.html` is missing: dashboard build runs (~7s), then embed-assets regenerates.

Always regenerating `embedded-assets.ts` prevents stale-asset crashes when a
developer manually rebuilds the dashboard (Vite regenerates content hashes
on every build). The previous script only checked file existence, which
left stale imports that crashed at module load.

The guard adds ~50ms overhead to warm starts. The alternative — an
unconditional `predev: "bun run build:dashboard"` — would add ~7s to
every `bun run dev`.

`src/embedded-assets.ts` is committed to git (not gitignored) because
`bun build --compile` needs it present at compile time, and the release
workflow in CI runs `build:dashboard` → `build:embed-assets` →
`bun build --compile` explicitly. The `predev` guard protects the
developer path; CI remains explicit.
