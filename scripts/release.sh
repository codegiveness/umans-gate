#!/usr/bin/env bash
set -euo pipefail

# Release helper: bumps version, syncs version across files, updates docs,
# commits, tags, and pushes. The tag push triggers .github/workflows/release.yml
# which creates the GitHub Release, builds standalone binaries, and publishes to npm.
#
# Usage:
#   bun run release                    # patch: 0.3.14 → 0.3.15
#   bun run release minor             # minor:  0.3.14 → 0.4.0
#   bun run release major              # major:  0.3.14 → 1.0.0
#   bun run release 0.4.2              # explicit version
#
# Prerequisites:
#   - Clean working tree (no uncommitted changes)
#   - On master branch
#   - typecheck + lint + tests pass
#   - CHANGELOG.md has a [## Unreleased] section
#
# What this script does:
#   1. Runs pre-flight checks (typecheck, lint, test, build)
#   2. Bumps package.json version
#   3. Runs sync-version.ts --sync --allow-untagged (syncs dashboard/package.json)
#   4. Runs update-docs.ts --update (stamps ROADMAP, regenerates docs index)
#   5. Validates CHANGELOG.md has a section for the new version
#   6. Commits + tags + pushes (triggers release.yml)

cd "$(dirname "$0")/.."

# ─── Guards ────────────────────────────────────────────────────────────────

BRANCH=$(git branch --show-current)
if [ "$BRANCH" != "master" ]; then
  echo "❌ Not on master (current: $BRANCH). Switch to master first."
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "❌ Working tree is not clean. Commit or stash changes first."
  git status --short
  exit 1
fi

# ─── Determine version ─────────────────────────────────────────────────────

CURRENT=$(node -p "require('./package.json').version")
BUMP="${1:-patch}"

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
else
  NEW_VERSION=$(npm version "$BUMP" --no-git-tag-version --no-commit-hooks 2>/dev/null | sed 's/^v//')
  if [ -z "$NEW_VERSION" ]; then
    echo "❌ Invalid bump type: $BUMP (use patch, minor, major, or x.y.z)"
    exit 1
  fi
  git checkout package.json
fi

echo "📦 Releasing: $CURRENT → $NEW_VERSION ($BUMP)"

# ─── Pre-flight checks ─────────────────────────────────────────────────────

echo "🔍 Running typecheck..."
bun run typecheck

echo "🔍 Running lint..."
bun run lint

echo "🔍 Running tests..."
bun test --timeout 30000

echo "🔍 Running build..."
bun run build

# ─── Bump version ──────────────────────────────────────────────────────────

node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"

echo "🔄 Syncing version across files (dashboard/package.json)..."
bun run scripts/sync-version.ts --sync --allow-untagged

echo "🔄 Updating docs (ROADMAP stamps, docs index)..."
bun run scripts/update-docs.ts --update

# ─── Changelog validation ─────────────────────────────────────────────────

# Ensure changelog has an entry for the new version
if ! grep -q "## \[$NEW_VERSION\]" CHANGELOG.md; then
  TODAY=$(date +%Y-%m-%d)
  NEW_VERSION="$NEW_VERSION" TODAY="$TODAY" node -e "
    const fs = require('fs');
    let c = fs.readFileSync('CHANGELOG.md', 'utf8');
    c = c.replace(
      /## \[Unreleased\]/,
      '## [Unreleased]\n\n## [' + process.env.NEW_VERSION + '] - ' + process.env.TODAY
    );
    fs.writeFileSync('CHANGELOG.md', c);
  "
  echo "📝 Added [$NEW_VERSION] section to CHANGELOG.md"
  echo "   Edit CHANGELOG.md now to add release notes, then re-run."
  exit 1
fi

# ─── Final validation ──────────────────────────────────────────────────────

echo "🔍 Final version consistency check..."
bun run scripts/sync-version.ts --allow-untagged

# ─── Commit + tag + push ───────────────────────────────────────────────────

git add package.json dashboard/package.json CHANGELOG.md ROADMAP.md docs/README.md
git commit -m "release: v$NEW_VERSION

- Sync dashboard/package.json version
- Update ROADMAP.md stamps
- Regenerate docs/README.md index"

git tag "v$NEW_VERSION"
git push origin master
git push origin "v$NEW_VERSION"

echo ""
echo "✅ Released v$NEW_VERSION"
echo "   Tag v$NEW_VERSION pushed — GitHub Actions release.yml will:"
echo "   - Create GitHub Release with changelog notes"
echo "   - Build standalone binaries (6 platforms)"
echo "   - Publish to npm"
echo ""
echo "   Monitor: https://github.com/codegiveness/umans-gate/actions"
