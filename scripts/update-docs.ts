#!/usr/bin/env bun
/**
 * update-docs.ts — keep docs in sync on every release.
 *
 * Does three things:
 *   1. Updates ROADMAP.md "Applies to" and "Last updated" stamps.
 *   2. Validates every markdown link in docs/ + root *.md resolves.
 *   3. Regenerates docs/README.md index with "last updated" dates.
 *
 * Usage:
 *   bun run scripts/update-docs.ts              # validate (exit 1 on broken links)
 *   bun run scripts/update-docs.ts --update      # update stamps + regenerate index
 *
 * Exit codes:
 *   0 — docs consistent (or updated successfully)
 *   1 — broken links found
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

type Mode = "validate" | "update";

function parseArgs(): { mode: Mode } {
  const args = process.argv.slice(2);
  return { mode: args.includes("--update") ? "update" : "validate" };
}

const rootDir = new URL("../", import.meta.url).pathname;
const { mode } = parseArgs();

// ─── 1. Doc stamp updates (ROADMAP + docs/*.md) ───────────────────────────

function updateDocStamps(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  let content = readFileSync(filePath, "utf8");
  const today = new Date().toISOString().slice(0, 10);
  const pkg = JSON.parse(readFileSync(`${rootDir}package.json`, "utf8"));
  const version = pkg.version;
  let changed = false;

  const appliesRegex = /\*\*Applies to:\*\* umans-gate v?[0-9]+\.[0-9]+\.[0-9]+/;
  if (appliesRegex.test(content)) {
    content = content.replace(appliesRegex, `**Applies to:** umans-gate v${version}`);
    changed = true;
  }

  const updatedRegex = /\*\*Last updated:\*\* [0-9]{4}-[0-9]{2}-[0-9]{2}/;
  if (updatedRegex.test(content)) {
    content = content.replace(updatedRegex, `**Last updated:** ${today}`);
    changed = true;
  }

  if (changed && mode === "update") {
    writeFileSync(filePath, content);
  }
  return changed;
}

function updateAllDocStamps(): string[] {
  const updated: string[] = [];
  const roadmapPath = `${rootDir}ROADMAP.md`;
  if (updateDocStamps(roadmapPath)) {
    updated.push("ROADMAP.md");
  }
  const docsDir = `${rootDir}docs/`;
  if (existsSync(docsDir)) {
    for (const entry of readdirSync(docsDir)) {
      if (entry.endsWith(".md") && entry !== "README.md") {
        const fullPath = join(docsDir, entry);
        if (updateDocStamps(fullPath)) {
          updated.push(`docs/${entry}`);
        }
      }
    }
    // Also stamp docs/reference/*.md — non-recursive scan above misses them
    const referenceDir = join(docsDir, "reference");
    if (existsSync(referenceDir)) {
      for (const entry of readdirSync(referenceDir)) {
        if (entry.endsWith(".md")) {
          const fullPath = join(referenceDir, entry);
          if (updateDocStamps(fullPath)) {
            updated.push(`docs/reference/${entry}`);
          }
        }
      }
    }
  }
  return updated;
}

// ─── 2. Link validation ──────────────────────────────────────────────────

interface BrokenLink {
  file: string;
  link: string;
  reason: string;
}

function extractMarkdownLinks(content: string): string[] {
  const links: string[] = [];
  // Match [text](path) — skip http(s) and anchors-only
  const regex = /\[([^\]]*)\]\(([^)]+)\)/g;
  for (const match of content.matchAll(regex)) {
    const target = String(match[2]).trim();
    if (target.startsWith("http")) continue;
    if (target.startsWith("#")) continue;
    // Strip anchor from local paths
    const path = target.split("#")[0];
    if (path) links.push(path);
  }
  return links;
}

function validateLinks(): BrokenLink[] {
  const broken: BrokenLink[] = [];
  const mdFiles: string[] = [];

  function collectMd(dir: string): void {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      const full = join(dir, entry);
      const stat = statSync(full);
      if (stat.isDirectory()) {
        if (
          entry.startsWith(".") ||
          entry === "node_modules" ||
          entry === "dist" ||
          entry === "release"
        )
          continue;
        collectMd(full);
      } else if (entry.endsWith(".md")) {
        mdFiles.push(full);
      }
    }
  }

  collectMd(rootDir);

  for (const file of mdFiles) {
    const content = readFileSync(file, "utf8");
    const links = extractMarkdownLinks(content);
    for (const link of links) {
      const target = resolve(dirname(file), link);
      if (!existsSync(target)) {
        // Skip if target is gitignored (local-only file, not in CI checkout)
        let isGitignored = false;
        try {
          execSync(`git check-ignore --quiet "${target}"`, { stdio: "ignore" });
          isGitignored = true;
        } catch {
          // git check-ignore exits 1 if NOT ignored
        }
        if (!isGitignored) {
          broken.push({
            file: relative(rootDir, file),
            link,
            reason: "target does not exist",
          });
        }
      }
    }
  }

  return broken;
}

// ─── 3. Docs index regeneration ────────────────────────────────────────────

function lastModified(file: string): string {
  try {
    const stat = statSync(file);
    return stat.mtime.toISOString().slice(0, 10);
  } catch {
    return "unknown";
  }
}

function regenerateDocsIndex(): boolean {
  const docsReadmePath = `${rootDir}docs/README.md`;
  if (!existsSync(docsReadmePath)) return false;

  const pkg = JSON.parse(readFileSync(`${rootDir}package.json`, "utf8"));
  const version = pkg.version;
  const today = new Date().toISOString().slice(0, 10);

  // Collect doc files with their last-modified dates
  const docFiles: { path: string; name: string; mtime: string }[] = [];
  const docsDir = `${rootDir}docs/`;
  if (existsSync(docsDir)) {
    for (const entry of readdirSync(docsDir)) {
      if (entry.endsWith(".md") && entry !== "README.md") {
        const full = join(docsDir, entry);
        docFiles.push({
          path: entry,
          name: entry.replace(".md", ""),
          mtime: lastModified(full),
        });
      }
    }
  }

  // Regenerate with header stamp
  const lines: string[] = [
    "# umans-gate Documentation",
    "",
    `> **Current version:** v${version} · **Index updated:** ${today}`,
    "",
    "## Start here",
    "",
    "- [README.md](../README.md) — install, quick start, full config reference, usage rights",
    "- [PRODUCT.md](PRODUCT.md) — what this project is and who it's for",
    "",
    "## Understand the system",
    "",
    "- [ARCHITECTURE.md](ARCHITECTURE.md) — system design, data flow, stamp pipeline, concurrency gate",
    "- [proxy-modifications.md](proxy-modifications.md) — every modification the proxy applies to traffic",
    "",
    "## Operate it",
    "",
    "- [OPERATIONS.md](OPERATIONS.md) — day-to-day operations: start/stop, upgrades, health checks, backup",
    "- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — common issues and solutions",
    "- [BENCHMARKS.md](BENCHMARKS.md) — performance characteristics and benchmark results",
    "",
    "## Develop and extend",
    "",
    "- [CONTRIBUTING.md](../CONTRIBUTING.md) — development setup, code style, testing",
    "- [AGENTS.md](../AGENTS.md) — guidance for AI agents working in this codebase",
    "- [SECURITY.md](../SECURITY.md) — vulnerability reporting and security practices",
    "- [ROADMAP.md](../ROADMAP.md) — planned direction",
    "",
    "## Reference",
    "",
    "- [CHANGELOG.md](../CHANGELOG.md) — version history",
    "- [what-work-with-umans.md](what-work-with-umans.md) — feature mappings to umans-open-stack playbooks",
    "- [Dashboard Design System](../dashboard/DESIGN.md) — design tokens and component guidelines",
    "- Per-tab reference:",
    "  - [captures.md](reference/captures.md) — Captures tab",
    "  - [config.md](reference/config.md) — Config tab",
    "  - [economics.md](reference/economics.md) — Economics tab",
    "  - [models.md](reference/models.md) — Models tab",
    "  - [performance.md](reference/performance.md) — Performance tab",
    "  - [usage.md](reference/usage.md) — Usage tab",
    "  - [vision.md](reference/vision.md) — Vision Calls tab",
  ];

  if (mode === "update") {
    writeFileSync(docsReadmePath, `${lines.join("\n")}\n`);
  }
  return true;
}

// ─── Main ─────────────────────────────────────────────────────────────────

const fixes: string[] = [];

// 1. Doc stamps (ROADMAP + docs/*.md)
if (mode === "update") {
  const updated = updateAllDocStamps();
  if (updated.length > 0) {
    fixes.push(`Doc stamps updated: ${updated.join(", ")}`);
  }
}

// 2. Link validation (always runs)
const brokenLinks = validateLinks();
if (brokenLinks.length > 0) {
  console.error("❌ Broken doc links found:");
  for (const b of brokenLinks) {
    console.error(`   ${b.file}: \`${b.link}\` — ${b.reason}`);
  }
  process.exit(1);
}

// 3. Docs index regeneration
if (mode === "update") {
  if (regenerateDocsIndex()) {
    fixes.push("docs/README.md: regenerated index with version stamp");
  }
}

// ─── Report ───────────────────────────────────────────────────────────────

if (fixes.length > 0) {
  console.log("✅ Docs updated:");
  for (const f of fixes) console.log(`   ${f}`);
}

if (fixes.length === 0) {
  console.log("✅ Docs consistent — no broken links found");
}
