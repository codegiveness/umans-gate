// Self-update logic for umans-gate.
// Detects install method (npm global, standalone executable, or bun dev)
// and performs the appropriate update action.

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

const GITHUB_API = "https://api.github.com/repos/codegiveness/umans-gate/releases/latest";

interface GithubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string }>;
}

/** Fetch latest version from GitHub Releases. */
async function fetchLatestVersion(): Promise<string | null> {
  try {
    const resp = await fetch(GITHUB_API, {
      headers: { "User-Agent": "umans-gate-updater" },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as GithubRelease;
    return data.tag_name.replace(/^v/, "");
  } catch {
    return null;
  }
}

/** Check if running as a compiled standalone executable. */
function isCompiledExecutable(): boolean {
  // In compiled mode, process.execPath points to the binary itself,
  // not to a bun/node executable.
  const execPath = process.execPath;
  return existsSync(execPath) && execPath.includes("umans-gate");
}

/** Check if running as npm global install. */
function isNpmGlobal(): boolean {
  try {
    const npmRoot = execSync("npm root -g", { encoding: "utf-8" }).trim();
    return existsSync(`${npmRoot}/umans-gate`);
  } catch {
    return false;
  }
}

/** Compare two semver strings (returns -1, 0, 1). */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/** Check for available update without installing. Prints result and exits. */
export async function checkForUpdate(currentVersion: string): Promise<void> {
  console.log("Checking for updates...");
  const latest = await fetchLatestVersion();
  if (!latest) {
    console.error("Could not fetch latest version from GitHub.");
    process.exit(1);
  }

  const cmp = compareVersions(currentVersion, latest);
  if (cmp < 0) {
    console.log(`Update available: ${currentVersion} → ${latest}`);
    console.log("Run `umans-gate update` to install.");
  } else if (cmp === 0) {
    console.log(`Already up to date (v${currentVersion}).`);
  } else {
    console.log(`Running ahead of latest release (${currentVersion} > ${latest}).`);
  }
}

/** Perform the update based on install method. */
export async function performUpdate(currentVersion: string): Promise<void> {
  console.log("Checking for updates...");
  const latest = await fetchLatestVersion();
  if (!latest) {
    console.error("Could not fetch latest version from GitHub.");
    process.exit(1);
  }

  const cmp = compareVersions(currentVersion, latest);
  if (cmp >= 0) {
    console.log(`Already up to date (v${currentVersion}).`);
    return;
  }

  console.log(`Updating: ${currentVersion} → ${latest}`);

  if (isNpmGlobal()) {
    console.log("Install method: npm global");
    try {
      execSync("npm update -g umans-gate", { stdio: "inherit" });
      console.log("Update complete.");
    } catch {
      console.error("npm update failed. Try manually: npm install -g umans-gate@latest");
      process.exit(1);
    }
  } else if (isCompiledExecutable()) {
    console.log("Install method: standalone executable");
    console.log("Please download the latest binary from:");
    console.log("  https://github.com/codegiveness/umans-gate/releases/latest");
    console.log("Or reinstall via the install script:");
    console.log(
      "  curl -fsSL https://raw.githubusercontent.com/codegiveness/umans-gate/main/install.sh | sh",
    );
  } else {
    console.log("Install method: development");
    console.log("Pull the latest changes and reinstall:");
    console.log("  git pull && bun install && bun run build");
  }
}
