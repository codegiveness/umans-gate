#!/usr/bin/env bash
set -euo pipefail

# Build standalone executables for all 6 platforms via cross-compilation.
# Requires: bun (>=1.1.0), dashboard already built (bun run build:dashboard)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "${SCRIPT_DIR}")"
RELEASE_DIR="${ROOT}/release"

mkdir -p "${RELEASE_DIR}"

# Generate embedded-assets.ts from dashboard build
echo "→ Generating embedded-assets.ts..."
bun run "${SCRIPT_DIR}/embed-assets.ts"

# Build all 6 platform targets
TARGETS=(
  "darwin-arm64"
  "darwin-x64"
  "linux-x64"
  "linux-arm64"
  "win32-x64"
  "win32-arm64"
)

for target in "${TARGETS[@]}"; do
  ext=""
  [[ "$target" == win32-* ]] && ext=".exe"
  outfile="${RELEASE_DIR}/umans-gate-${target}${ext}"
  echo "→ Building ${target}..."
  bun build --compile --target=bun-${target} ./src/cli.ts --outfile "${outfile}"
done

# Generate SHA256SUMS
echo "→ Generating SHA256SUMS..."
(cd "${RELEASE_DIR}" && sha256sum umans-gate-* > SHA256SUMS)

echo "✅ Built 6 executables in ${RELEASE_DIR}"
