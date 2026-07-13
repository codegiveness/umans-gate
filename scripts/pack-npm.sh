#!/usr/bin/env bash
set -euo pipefail

# Assemble npm packages from compiled executables.
# Usage: bash scripts/pack-npm.sh <version>
# Expects: release/umans-gate-{target} executables already built.

if [ $# -lt 1 ]; then
  echo "Usage: $0 <version>"
  exit 1
fi

VERSION="$1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "${SCRIPT_DIR}")"
RELEASE_DIR="${ROOT}/release"
NPM_DIR="${RELEASE_DIR}/npm"

declare -A OS_MAP=(
  ["darwin-arm64"]="darwin"
  ["darwin-x64"]="darwin"
  ["linux-x64"]="linux"
  ["linux-arm64"]="linux"
  ["win32-x64"]="win32"
  ["win32-arm64"]="win32"
)
declare -A CPU_MAP=(
  ["darwin-arm64"]="arm64"
  ["darwin-x64"]="x64"
  ["linux-x64"]="x64"
  ["linux-arm64"]="arm64"
  ["win32-x64"]="x64"
  ["win32-arm64"]="arm64"
)

rm -rf "${NPM_DIR}"
mkdir -p "${NPM_DIR}"

# --- Platform packages ---
for target in "${!OS_MAP[@]}"; do
  os="${OS_MAP[$target]}"
  cpu="${CPU_MAP[$target]}"
  ext=""
  [[ "$target" == win32-* ]] && ext=".exe"
  exec_name="umans-gate-${target}${ext}"
  exec_path="${RELEASE_DIR}/${exec_name}"

  if [ ! -f "${exec_path}" ]; then
    echo "⚠️  Skipping ${target}: ${exec_path} not found"
    continue
  fi

  pkg_dir="${NPM_DIR}/umans-gate-${target}"
  mkdir -p "${pkg_dir}"
  cp "${exec_path}" "${pkg_dir}/"

  cat > "${pkg_dir}/package.json" <<EOF
{
  "name": "umans-gate-${target}",
  "version": "${VERSION}",
  "description": "Standalone binary for umans-gate (${target})",
  "os": ["${os}"],
  "cpu": ["${cpu}"],
  "files": ["umans-gate-${target}${ext}"]
}
EOF
  echo "✅ Packaged umans-gate-${target}"
done

# --- Main shim package ---
MAIN_DIR="${NPM_DIR}/main"
mkdir -p "${MAIN_DIR}/dist"

# Copy type declarations (cd first so --parents preserves relative paths, not absolute)
if [ -d "${ROOT}/dist" ]; then
  (cd "${ROOT}/dist" && find . -name "*.d.ts" -exec cp --parents {} "${MAIN_DIR}/" \;) 2>/dev/null || true
fi

# Copy npm-shim.cjs
cp "${ROOT}/npm-shim.cjs" "${MAIN_DIR}/npm-shim.cjs"

# Copy docs required by package.json "files" field
cp "${ROOT}/README.md" "${MAIN_DIR}/" 2>/dev/null || true
cp "${ROOT}/LICENSE" "${MAIN_DIR}/" 2>/dev/null || true
cp "${ROOT}/CHANGELOG.md" "${MAIN_DIR}/" 2>/dev/null || true

# Write main package.json
cat > "${MAIN_DIR}/package.json" <<EOF
{
  "name": "umans-gate",
  "version": "${VERSION}",
  "description": "LLM capture proxy with live inspection dashboard",
  "bin": { "umans-gate": "./npm-shim.cjs" },
  "files": ["npm-shim.cjs", "dist"],
  "engines": { "node": ">=18.0.0" },
  "optionalDependencies": {
    "umans-gate-darwin-arm64": "${VERSION}",
    "umans-gate-darwin-x64": "${VERSION}",
    "umans-gate-linux-x64": "${VERSION}",
    "umans-gate-linux-arm64": "${VERSION}",
    "umans-gate-win32-x64": "${VERSION}",
    "umans-gate-win32-arm64": "${VERSION}"
  }
}
EOF

echo "✅ npm packages assembled in ${NPM_DIR}"
