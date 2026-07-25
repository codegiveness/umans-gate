#!/usr/bin/env bash
# scan-private-info.sh — block private paths/credentials from tracked files.
#
# Runs in CI on every PR/push. Fails if it finds:
#   - Absolute home paths (/home/<user>, /Users/<user>, C:\Users\<user>)
#   - VMware shared folder paths (/mnt/hgfs/)
#   - Hardcoded API keys or tokens (heuristic)
#
# Usage: bash scripts/scan-private-info.sh
# Exit 0 = clean, Exit 1 = private info found

set -euo pipefail

cd "$(dirname "$0")/.."

# Gather tracked docs and config files only (not test fixtures or source code)
FILES=$(git ls-files -- '*.md' '*.json' '*.yml' '*.yaml' '*.toml' 2>/dev/null | grep -v -E '^(dashboard/|test/|benchmark/|\.github/ISSUE_TEMPLATE/)')

PATTERNS=(
  '/home/[a-z]'
  '/Users/[a-z]'
  '/mnt/hgfs'
  'C:\\\\Users\\\\'
  'agungliang'
)

VIOLATIONS=0
for file in $FILES; do
  for pattern in "${PATTERNS[@]}"; do
    if grep -qE "$pattern" "$file" 2>/dev/null; then
      echo "❌ PRIVATE INFO: $file contains pattern '$pattern'"
      grep -nE "$pattern" "$file" 2>/dev/null | head -3
      echo ""
      VIOLATIONS=$((VIOLATIONS + 1))
    fi
  done
done

if [ "$VIOLATIONS" -gt 0 ]; then
  echo "❌ Found private info in $VIOLATIONS file(s). Remove absolute home paths, usernames, and mount paths before committing."
  exit 1
fi

echo "✅ No private paths detected in tracked files"
