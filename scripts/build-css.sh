#!/usr/bin/env bash
set -euo pipefail

# Build static/app.css from assets/app.css using the Tailwind CSS v4 standalone CLI.
# No Node.js and no tailwind.config.js required.

TAILWIND_VERSION="v4.1.0"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN="${ROOT_DIR}/tailwindcss"
INPUT="${ROOT_DIR}/assets/app.css"
OUTPUT="${ROOT_DIR}/static/app.css"

EXTRA_ARGS=("$@")

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Linux) PLATFORM="linux-x64" ;;
  Darwin)
    case "$ARCH" in
      arm64) PLATFORM="macos-arm64" ;;
      x86_64) PLATFORM="macos-x64" ;;
      *) echo "Unsupported macOS architecture: $ARCH" >&2; exit 1 ;;
    esac
    ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

if [[ ! -x "$BIN" ]]; then
  echo "Downloading Tailwind CSS ${TAILWIND_VERSION} standalone binary (${PLATFORM})..."
  curl -fsSL "https://github.com/tailwindlabs/tailwindcss/releases/download/${TAILWIND_VERSION}/tailwindcss-${PLATFORM}" -o "$BIN"
  chmod +x "$BIN"
fi

mkdir -p "$(dirname "$OUTPUT")"
echo "Building ${OUTPUT}..."
"$BIN" -i "$INPUT" -o "$OUTPUT" --minify "${EXTRA_ARGS[@]}"
echo "Done: ${OUTPUT}"
