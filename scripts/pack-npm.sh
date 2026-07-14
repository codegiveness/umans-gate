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
SCOPE="@codegiveness"

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

# --- Download NSSM for Windows packages ---
NSSM_VERSION="2.24"
NSSM_CACHE="${ROOT}/.cache/nssm"
NSSM_EXE="${NSSM_CACHE}/nssm-${NSSM_VERSION}/win64/nssm.exe"

if [ ! -f "${NSSM_EXE}" ]; then
  echo "📥 Downloading NSSM ${NSSM_VERSION}..."
  mkdir -p "${NSSM_CACHE}"
  NSSM_ZIP="${NSSM_CACHE}/nssm-${NSSM_VERSION}.zip"
  curl -fsSL -o "${NSSM_ZIP}" "https://nssm.cc/release/nssm-${NSSM_VERSION}.zip" || {
    echo "⚠️  Failed to download NSSM. Windows packages will not include nssm.exe."
    echo "   Service install on Windows will not work until NSSM is bundled."
  }
  if [ -f "${NSSM_ZIP}" ]; then
    (cd "${NSSM_CACHE}" && unzip -o "nssm-${NSSM_VERSION}.zip" >/dev/null 2>&1) || true
  fi
fi

if [ -f "${NSSM_EXE}" ]; then
  echo "✅ NSSM available at ${NSSM_EXE}"
else
  echo "⚠️  NSSM not found. Windows packages will not include nssm.exe."
fi

# --- Platform packages (scoped: @codegiveness/umans-gate-<target>) ---
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

  # Scoped package directory: @codegiveness/umans-gate-<target>
  pkg_dir="${NPM_DIR}/${SCOPE}/umans-gate-${target}"
  mkdir -p "${pkg_dir}"
  # Copy executable
  cp "${exec_path}" "${pkg_dir}/"

  # For Windows packages, also include nssm.exe (Windows Service manager)
  if [[ "$target" == win32-* ]] && [ -f "${NSSM_EXE}" ]; then
    cp "${NSSM_EXE}" "${pkg_dir}/nssm.exe"
    files_list="\"umans-gate-${target}${ext}\", \"nssm.exe\""
  else
    files_list="\"umans-gate-${target}${ext}\""
  fi

  cat > "${pkg_dir}/package.json" <<EOF
{
  "name": "${SCOPE}/umans-gate-${target}",
  "version": "${VERSION}",
  "description": "umans-gate standalone binary for ${target}",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/codegiveness/umans-gate.git",
    "directory": "scripts/pack-npm.sh"
  },
  "homepage": "https://github.com/codegiveness/umans-gate#readme",
  "bugs": { "url": "https://github.com/codegiveness/umans-gate/issues" },
  "license": "MIT",
  "os": ["${os}"],
  "cpu": ["${cpu}"],
  "files": [${files_list}]
}
EOF
  echo "✅ Packaged ${SCOPE}/umans-gate-${target}"
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

# Copy docs
cp "${ROOT}/README.md" "${MAIN_DIR}/" 2>/dev/null || true
cp "${ROOT}/LICENSE" "${MAIN_DIR}/" 2>/dev/null || true
cp "${ROOT}/CHANGELOG.md" "${MAIN_DIR}/" 2>/dev/null || true

# Write main package.json with scoped optionalDependencies
cat > "${MAIN_DIR}/package.json" <<EOF
{
  "name": "umans-gate",
  "version": "${VERSION}",
  "description": "LLM capture proxy with Anthropic cache_control TTL stamping, vision handoff, concurrency gating, rate limiting, and a live inspection dashboard",
  "repository": { "type": "git", "url": "git+https://github.com/codegiveness/umans-gate.git" },
  "homepage": "https://github.com/codegiveness/umans-gate#readme",
  "bugs": { "url": "https://github.com/codegiveness/umans-gate/issues" },
  "license": "MIT",
  "bin": { "umans-gate": "./npm-shim.cjs" },
  "files": ["npm-shim.cjs", "dist", "README.md", "LICENSE", "CHANGELOG.md"],
  "engines": { "node": ">=18.0.0" },
  "keywords": ["llm", "proxy", "capture", "anthropic", "openai", "cache-control", "ttl", "inspector", "debugger", "websocket", "claude", "prompt-engineering", "observability", "sqlite", "bun", "developer-tools", "api-proxy", "prompt-caching"],
  "optionalDependencies": {
    "${SCOPE}/umans-gate-darwin-arm64": "${VERSION}",
    "${SCOPE}/umans-gate-darwin-x64": "${VERSION}",
    "${SCOPE}/umans-gate-linux-x64": "${VERSION}",
    "${SCOPE}/umans-gate-linux-arm64": "${VERSION}",
    "${SCOPE}/umans-gate-win32-x64": "${VERSION}",
    "${SCOPE}/umans-gate-win32-arm64": "${VERSION}"
  }
}
EOF

echo "✅ npm packages assembled in ${NPM_DIR}"
