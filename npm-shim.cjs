#!/usr/bin/env node
// Thin launcher: finds the platform binary and exec's it.
// Uses require() (CommonJS) intentionally — .cjs extension forces CJS parsing.
const { spawnSync, execSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

const platform = process.platform;
const arch = process.arch;

const SCOPE = "@codegiveness";
const platformMap = {
  darwin: { arm64: "darwin-arm64", x64: "darwin-x64" },
  linux: { arm64: "linux-arm64", x64: "linux-x64" },
  win32: { arm64: "win32-arm64", x64: "win32-x64" },
};

const target = platformMap[platform]?.[arch];
if (!target) {
  console.error(`umans-gate: unsupported platform ${platform}-${arch}`);
  process.exit(1);
}

const ext = platform === "win32" ? ".exe" : "";
const binName = `umans-gate-${target}${ext}`;

// Search order for the platform binary:
// 1. Sibling to this shim (npm local install: node_modules/umans-gate-<target>/)
// 2. Global npm prefix (npm global install: node_modules/umans-gate-<target>/)
// 3. require.resolve fallback
let binPath = null;

// Try 1: sibling directory (npm hoists optionalDependencies to top-level node_modules/)
// When umans-gate is installed, @codegiveness/umans-gate-<target> is a sibling package.
const localPath = path.join(__dirname, "..", SCOPE, `umans-gate-${target}`, binName);
if (fs.existsSync(localPath)) {
  binPath = localPath;
}

// Try 2: global npm prefix
if (!binPath) {
  try {
    const globalPrefix = execSync("npm root -g", { encoding: "utf8" }).trim();
    const globalPath = path.join(globalPrefix, SCOPE, `umans-gate-${target}`, binName);
    if (fs.existsSync(globalPath)) {
      binPath = globalPath;
    }
  } catch {
    // npm not available — skip
  }
}

// Try 3: require.resolve the platform package
if (!binPath) {
  try {
    const pkgPath = require.resolve(`${SCOPE}/umans-gate-${target}/package.json`);
    binPath = path.join(path.dirname(pkgPath), binName);
  } catch {
    // Package not found — fall through to error
  }
}

if (!binPath || !fs.existsSync(binPath)) {
  console.error(`umans-gate: platform binary not found for ${target}.`);
  console.error(`  Tried: ${localPath}`);
  console.error(`  Install it with: npm install ${SCOPE}/umans-gate-${target}`);
  process.exit(1);
}

const result = spawnSync(binPath, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status || 1);
