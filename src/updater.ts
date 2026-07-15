// Self-update logic for umans-gate.
// Detects install method (npm global, standalone executable, or bun dev)
// and performs the appropriate update action.

import { execSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";

const GITHUB_API = "https://api.github.com/repos/codegiveness/umans-gate/releases/latest";

const SHA256SUMS_ASSET = "SHA256SUMS";

/**
 * Parse a SHA256SUMS file (standard `sha256sum` output) and return the
 * hex digest for the given asset name.
 *
 * Each line is expected to be `<64-char hex digest>  <filename>` (text mode)
 * or `<64-char hex digest> *<filename>` (binary mode).
 * Returns `null` if the asset is not found or the file is malformed.
 */
export function parseSha256Sums(sums: string, assetName: string): string | null {
  const lines = sums.split("\n");
  for (const line of lines) {
    // Match: <64 hex chars> <separator> <filename>
    // Separator is two spaces (text mode) or space+asterisk (binary mode)
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line.trim());
    if (!match) continue;
    const [, digest, name] = match;
    if (name === assetName) {
      return digest.toLowerCase();
    }
  }
  return null;
}

/** Compute the SHA-256 hex digest of the given data. */
export function computeSha256(data: Uint8Array | ArrayBuffer): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(data);
  return hasher.digest("hex");
}

interface GithubRelease {
  tag_name: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
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

/** Fetch the full release data including assets. */
async function fetchLatestRelease(): Promise<GithubRelease | null> {
  try {
    const resp = await fetch(GITHUB_API, {
      headers: { "User-Agent": "umans-gate-updater" },
    });
    if (!resp.ok) return null;
    return (await resp.json()) as GithubRelease;
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

/** Map current platform + arch to the GitHub release asset name. */
function platformAssetName(): string | null {
  const p = platform();
  const a = arch();

  const archMap: Record<string, string> = {
    x64: "x64",
    arm64: "arm64",
  };
  const archStr = archMap[a];
  if (!archStr) return null;

  switch (p) {
    case "linux":
      return `umans-gate-linux-${archStr}`;
    case "darwin":
      return `umans-gate-darwin-${archStr}`;
    case "win32":
      return `umans-gate-win32-${archStr}.exe`;
    default:
      return null;
  }
}

/**
 * Download and replace the standalone binary from GitHub Releases.
 * The service must be stopped before calling this (done by the CLI update command).
 */
async function downloadAndReplaceStandaloneBinary(_latestVersion: string): Promise<void> {
  const release = await fetchLatestRelease();
  if (!release) {
    console.error("Could not fetch release assets from GitHub.");
    process.exit(1);
  }

  const assetName = platformAssetName();
  if (!assetName) {
    console.error(`Unsupported platform: ${platform()}/${arch()}`);
    process.exit(1);
  }

  const asset = release.assets.find((a) => a.name === assetName);
  if (!asset) {
    console.error(`Could not find asset "${assetName}" in the latest release.`);
    console.error("Available assets:");
    for (const a of release.assets) console.error(`  ${a.name}`);
    process.exit(1);
  }

  console.log(`Downloading ${asset.name} (${(asset.size / 1024 / 1024).toFixed(1)} MB)...`);

  const resp = await fetch(asset.browser_download_url, {
    headers: { "User-Agent": "umans-gate-updater" },
  });
  if (!resp.ok) {
    console.error(`Download failed: HTTP ${resp.status}`);
    process.exit(1);
  }

  const buffer = await resp.arrayBuffer();
  if (buffer.byteLength !== asset.size) {
    console.error(`Download size mismatch: expected ${asset.size}, got ${buffer.byteLength}`);
    process.exit(1);
  }

  const sumsAsset = release.assets.find((a) => a.name === SHA256SUMS_ASSET);
  if (!sumsAsset) {
    console.error("SHA256SUMS asset not found in release. Aborting for safety.");
    process.exit(1);
  }

  const sumsResp = await fetch(sumsAsset.browser_download_url, {
    headers: { "User-Agent": "umans-gate-updater" },
  });
  if (!sumsResp.ok) {
    console.error(`Failed to download SHA256SUMS: HTTP ${sumsResp.status}`);
    process.exit(1);
  }

  const sumsText = await sumsResp.text();
  const expectedDigest = parseSha256Sums(sumsText, assetName);
  if (!expectedDigest) {
    console.error(`Could not find "${assetName}" in SHA256SUMS. Aborting for safety.`);
    process.exit(1);
  }

  const actualDigest = computeSha256(buffer);
  if (actualDigest !== expectedDigest) {
    console.error("SHA-256 checksum mismatch!");
    console.error(`  Expected: ${expectedDigest}`);
    console.error(`  Actual:   ${actualDigest}`);
    console.error("The downloaded binary may be corrupted or tampered with. Aborting.");
    process.exit(1);
  }

  console.log("Checksum verified.");

  // Write to temp file, then replace
  const oldPath = process.execPath;
  const dir = dirname(oldPath);
  const tmpPath = join(dir, ".umans-gate-update.tmp");

  const fd = openSync(tmpPath, "w");
  writeSync(fd, Buffer.from(buffer));
  closeSync(fd);

  // Make executable on Unix
  if (platform() !== "win32") {
    chmodSync(tmpPath, 0o755);
  }

  // On Windows, the old binary may be locked if the service is running.
  // The CLI update command stops the service before calling this.
  try {
    renameSync(tmpPath, oldPath);
    console.log(`Replaced binary: ${oldPath}`);
  } catch {
    // rename may fail on Windows if file is locked, or cross-filesystem on Linux.
    // Try copy + delete as fallback.
    try {
      copyFileSync(tmpPath, oldPath);
      unlinkSync(tmpPath);
      console.log(`Replaced binary: ${oldPath}`);
    } catch (err) {
      console.error(
        `Failed to replace binary: ${err instanceof Error ? err.message : String(err)}`,
      );
      console.error(`The downloaded binary is at: ${tmpPath}`);
      console.error("You may need to replace it manually.");
      process.exit(1);
    }
  }
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
    await downloadAndReplaceStandaloneBinary(latest);
    console.log("Update complete.");
  } else {
    console.log("Install method: development");
    console.log("Pull the latest changes and reinstall:");
    console.log("  git pull && bun install && bun run build");
  }
}
