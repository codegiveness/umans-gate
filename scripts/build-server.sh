#!/usr/bin/env bash
set -euo pipefail

EA_FILE="src/embedded-assets.ts"
BACKUP="/tmp/umans-gate-ea-backup.ts"

# embedded-assets.ts contains `import ... with { type: "file" }` (Bun-specific).
# esbuild/tsup can't handle these, so temporarily replace with a stub.
if [ -f "$EA_FILE" ]; then
  cp "$EA_FILE" "$BACKUP"
  echo "export const EMBEDDED_ASSET_PATHS = [];" > "$EA_FILE"
fi

# Restore original on exit (even on failure).
restore() {
  if [ -f "$BACKUP" ]; then
    mv "$BACKUP" "$EA_FILE"
  fi
}
trap restore EXIT

npx tsup
