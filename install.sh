#!/bin/sh
# umans-gate — zero-devops Unix installer (curl | sh)
#
# Detects the host OS and architecture, queries GitHub Releases for the
# matching tar.gz asset, extracts the umans-gate binary, and installs it
# to $PREFIX (default /usr/local/bin).
#
# Usage:
#     curl -fsSL https://raw.githubusercontent.com/codegiveness/umans-gate/main/install.sh | sh
#     PREFIX=$HOME/.local/bin sh install.sh
#     sh install.sh --version v0.1.0
#
set -eu

REPO="codegiveness/umans-gate"
PREFIX="${PREFIX:-/usr/local/bin}"
VERSION=""

err() {
    printf 'install: error: %s\n' "$*" >&2
    exit 1
}

# --- Parse arguments --------------------------------------------------------

while [ $# -gt 0 ]; do
    case "$1" in
        --version)
            [ $# -ge 2 ] || err "--version requires an argument (e.g. --version v0.1.0)."
            VERSION="$2"
            shift 2
            ;;
        --version=*)
            VERSION="${1#--version=}"
            shift
            ;;
        --help|-h)
            echo "umans-gate installer"
            echo ""
            echo "Usage: sh install.sh [--version vX.Y.Z]"
            echo ""
            echo "Environment:"
            echo "  PREFIX  Install directory (default: /usr/local/bin)"
            exit 0
            ;;
        *)
            err "unknown argument: '$1'. Use --version vX.Y.Z or set the PREFIX env var."
            ;;
    esac
done

# --- Preflight --------------------------------------------------------------

command -v uname >/dev/null 2>&1 || err "'uname' not found."
command -v curl  >/dev/null 2>&1 || err "'curl' not found. Install it and rerun."
command -v tar   >/dev/null 2>&1 || err "'tar' not found. Install it and rerun."

# --- Detect platform --------------------------------------------------------

OS="$(uname -s)"
ARCH="$(uname -m)"

case "$ARCH" in
    x86_64|amd64)  ARCH_NORM="x86_64"  ;;
    aarch64|arm64) ARCH_NORM="aarch64" ;;
    *)
        err "unsupported architecture: '$ARCH'.
umans-gate provides prebuilt binaries for x86_64 and aarch64 only."
        ;;
esac

case "$OS" in
    Linux)
        case "$ARCH_NORM" in
            x86_64)  TARGET="x86_64-unknown-linux-gnu"  ;;
            aarch64) TARGET="aarch64-unknown-linux-gnu" ;;
        esac
        ;;
    Darwin)
        case "$ARCH_NORM" in
            x86_64)  TARGET="x86_64-apple-darwin"  ;;
            aarch64) TARGET="aarch64-apple-darwin" ;;
        esac
        ;;
    *)
        err "unsupported operating system: '$OS'.
umans-gate provides prebuilt binaries for Linux and macOS only."
        ;;
esac

echo "Platform:  $OS $ARCH_NORM"
echo "Target:    $TARGET"

# --- Query GitHub Releases --------------------------------------------------

if [ -n "$VERSION" ]; then
    API_URL="https://api.github.com/repos/$REPO/releases/tags/$VERSION"
    echo "Release:   $VERSION (requested)"
else
    API_URL="https://api.github.com/repos/$REPO/releases/latest"
    echo "Release:   latest"
fi

RESPONSE="$(curl -fsSL "$API_URL")" \
    || err "failed to fetch release metadata from GitHub.
Check your network connection and try again."

RELEASE_TAG="$(printf '%s\n' "$RESPONSE" | awk -F'"' '/"tag_name"/ {print $4; exit}')" \
    || RELEASE_TAG=""
[ -n "$RELEASE_TAG" ] \
    || err "could not parse the release tag from the GitHub API response."

echo "Version:   $RELEASE_TAG"

# --- Find the matching asset -----------------------------------------------
# cargo-dist archives are named: umans-gate-<target>.tar.gz

ASSET_URL=""
while IFS= read -r url; do
    [ -n "$url" ] || continue
    case "$url" in
        *"-${TARGET}.tar.gz")
            ASSET_URL="$url"
            break
            ;;
    esac
done <<ASSET_URLS
$(printf '%s\n' "$RESPONSE" | awk -F'"' '/"browser_download_url"/ {print $4}')
ASSET_URLS

if [ -z "$ASSET_URL" ]; then
    echo "install: error: no release asset found for target '$TARGET'." >&2
    echo "" >&2
    echo "Available assets:" >&2
    printf '%s\n' "$RESPONSE" | awk -F'"' '/"browser_download_url"/ {print $4}' >&2
    echo "" >&2
    echo "If your platform should be supported, open an issue:" >&2
    echo "  https://github.com/$REPO/issues" >&2
    exit 1
fi

echo "Asset:     ${ASSET_URL##*/}"

# --- Download and extract ---------------------------------------------------

TMPDIR="$(mktemp -d 2>/dev/null || mktemp -d -t umans-gate-install)" \
    || err "failed to create a temporary directory."
trap 'rm -rf "$TMPDIR"' EXIT

echo "Downloading ..."
curl -fsSL "$ASSET_URL" -o "$TMPDIR/archive.tar.gz" \
    || err "failed to download the archive. Check your network connection."

tar -xzf "$TMPDIR/archive.tar.gz" -C "$TMPDIR" \
    || err "failed to extract the archive. It may be corrupted; try re-running."

# Locate the umans-gate binary (archive root or one subdirectory level).
BINARY=""
for candidate in "$TMPDIR/umans-gate" "$TMPDIR"/*/umans-gate; do
    if [ -f "$candidate" ]; then
        BINARY="$candidate"
        break
    fi
done
[ -n "$BINARY" ] \
    || err "umans-gate binary not found inside the extracted archive."

# --- Install to PREFIX ------------------------------------------------------

mkdir -p "$PREFIX" 2>/dev/null || {
    echo "install: error: cannot create directory '$PREFIX' (permission denied)." >&2
    echo "" >&2
    echo "Try one of:" >&2
    echo "  sudo PREFIX=$PREFIX sh install.sh" >&2
    echo "  PREFIX=\$HOME/.local/bin sh install.sh" >&2
    exit 1
}

if ! install -m 0755 "$BINARY" "$PREFIX/umans-gate" 2>/dev/null; then
    echo "install: error: cannot write to '$PREFIX/umans-gate' (permission denied)." >&2
    echo "" >&2
    echo "Try one of:" >&2
    echo "  sudo PREFIX=$PREFIX sh install.sh" >&2
    echo "  PREFIX=\$HOME/.local/bin sh install.sh" >&2
    exit 1
fi

echo "Installed: $PREFIX/umans-gate"

# --- Verify -----------------------------------------------------------------

INSTALLED="$PREFIX/umans-gate"
if "$INSTALLED" --version 2>/dev/null; then
    :
else
    echo "install: warning: could not verify the binary with --version." >&2
    echo "  The file was installed but may not be runnable on this system." >&2
fi

# --- Next steps -------------------------------------------------------------

echo ""
echo "umans-gate $RELEASE_TAG is installed at $PREFIX/umans-gate"
if command -v umans-gate >/dev/null 2>&1; then
    echo ""
    echo "Next steps:"
    echo "  umans-gate          Run with zero config"
    echo "  umans-gate --help   See all commands"
else
    echo ""
    echo "Note: '$PREFIX' is not on your PATH. Add it:"
    echo "  export PATH=\"$PREFIX:\$PATH\""
    echo ""
    echo "Or run directly:"
    echo "  $PREFIX/umans-gate"
fi
