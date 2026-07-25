#!/usr/bin/env bun
import { execSync } from "node:child_process";
/**
 * sync-version.ts — single source of truth for version across the repo.
 *
 * `package.json` is the canonical version. This script:
 *   1. Syncs `dashboard/package.json` version to match root `package.json`.
 *   2. Validates that CHANGELOG.md has a `## [<version>]` section.
 *   3. Validates ROADMAP.md "Applies to" stamp matches current version.
 *   4. Validates the latest git tag matches `package.json` version (unless
 *      `--allow-untagged` is passed, used during release bump).
 *
 * Usage:
 *   bun run scripts/sync-version.ts              # validate (exit 1 on mismatch)
 *   bun run scripts/sync-version.ts --sync       # sync dashboard/package.json + validate
 *   bun run scripts/sync-version.ts --allow-untagged  # skip tag check (pre-release)
 *
 * Exit codes:
 *   0 — all consistent (or synced successfully)
 *   1 — mismatch found (use --sync to fix dashboard/package.json)
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

type Mode = "validate" | "sync";

function parseArgs(): { mode: Mode; allowUntagged: boolean } {
  const args = process.argv.slice(2);
  const mode: Mode = args.includes("--sync") ? "sync" : "validate";
  const allowUntagged = args.includes("--allow-untagged");
  return { mode, allowUntagged };
}

function readPkgVersion(path: string): string {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  return pkg.version;
}

function writeDashboardVersion(path: string, version: string): void {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.version = version;
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

function latestGitTag(): string | null {
  try {
    const tag = execSync("git describe --tags --abbrev=0 2>/dev/null", {
      encoding: "utf8",
    }).trim();
    return tag.replace(/^v/, "");
  } catch {
    return null;
  }
}

function validateChangelogHasVersion(changelogPath: string, version: string): boolean {
  if (!existsSync(changelogPath)) return false;
  const content = readFileSync(changelogPath, "utf8");
  return new RegExp(`^## \\[${version}\\]`, "m").test(content);
}

function validateRoadmapStamp(
  roadmapPath: string,
  version: string,
): {
  ok: boolean;
  current: string | null;
} {
  if (!existsSync(roadmapPath)) return { ok: false, current: null };
  const content = readFileSync(roadmapPath, "utf8");
  const match = content.match(/\*\*Applies to:\*\* umans-gate v?([0-9]+\.[0-9]+\.[0-9]+)/);
  if (!match) return { ok: false, current: null };
  return { ok: match[1] === version, current: match[1] };
}

// ─── Main ─────────────────────────────────────────────────────────────────

const { mode, allowUntagged } = parseArgs();
const rootDir = new URL("../", import.meta.url).pathname;

const rootVersion = readPkgVersion(`${rootDir}package.json`);
const dashboardPath = `${rootDir}dashboard/package.json`;
const changelogPath = `${rootDir}CHANGELOG.md`;
const roadmapPath = `${rootDir}ROADMAP.md`;

const errors: string[] = [];
const fixes: string[] = [];

// 1. Sync/validate dashboard/package.json
const dashVersion = readPkgVersion(dashboardPath);
if (dashVersion !== rootVersion) {
  if (mode === "sync") {
    writeDashboardVersion(dashboardPath, rootVersion);
    fixes.push(`dashboard/package.json: ${dashVersion} → ${rootVersion}`);
  } else {
    errors.push(
      `dashboard/package.json version (${dashVersion}) != package.json (${rootVersion}). Run: bun run scripts/sync-version.ts --sync`,
    );
  }
}

// 2. Validate CHANGELOG has version section
if (!validateChangelogHasVersion(changelogPath, rootVersion)) {
  errors.push(`CHANGELOG.md missing \`## [${rootVersion}]\` section. Add it under [Unreleased].`);
}

// 3. Validate ROADMAP stamp
const roadmap = validateRoadmapStamp(roadmapPath, rootVersion);
if (!roadmap.ok) {
  if (roadmap.current) {
    errors.push(
      `ROADMAP.md stamp (v${roadmap.current}) != package.json (${rootVersion}). Update the "Applies to" line.`,
    );
  } else {
    errors.push(`ROADMAP.md missing "Applies to: umans-gate vX.Y.Z" stamp. Add it to the header.`);
  }
}

// 4. Validate git tag matches (unless --allow-untagged for pre-release)
if (!allowUntagged) {
  const tag = latestGitTag();
  if (tag && tag !== rootVersion) {
    errors.push(
      `Latest git tag (v${tag}) != package.json (${rootVersion}). If releasing, pass --allow-untagged.`,
    );
  }
}

// ─── Report ───────────────────────────────────────────────────────────────

if (fixes.length > 0) {
  console.log("✅ Synced:");
  for (const f of fixes) console.log(`   ${f}`);
}

if (errors.length > 0) {
  console.error("❌ Version inconsistencies found:");
  for (const e of errors) console.error(`   ${e}`);
  process.exit(1);
}

if (fixes.length === 0 && errors.length === 0) {
  console.log(`✅ Version consistent: ${rootVersion}`);
}
