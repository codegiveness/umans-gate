// Self-update logic for umans-gate.
// Detects install method (npm global, standalone executable, or bun dev)
// and performs the appropriate update action.

import { execSync, spawn, spawnSync } from "node:child_process";
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
import { detectPlatform } from "./service/detect.js";
import { isServiceInstalled } from "./service/index.js";

const GITHUB_API = "https://api.github.com/repos/codegiveness/umans-gate/releases/latest";

const NPM_REGISTRY = "https://registry.npmjs.org/umans-gate/latest";

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
  body: string;
  assets: Array<{ name: string; browser_download_url: string; size: number }>;
}

/** Result of attempting to fetch the latest version. */
export interface VersionFetchResult {
  version: string | null;
  /** Human-readable explanation when `version` is null. */
  error: string | null;
}

/** Fetch latest version from the npm registry. */
async function fetchVersionFromNpm(): Promise<VersionFetchResult> {
  try {
    const resp = await fetch(NPM_REGISTRY, {
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) {
      return { version: null, error: `npm registry returned HTTP ${resp.status}` };
    }
    const data = (await resp.json()) as { version?: string };
    if (typeof data.version !== "string" || !data.version) {
      return { version: null, error: "npm registry response missing version field" };
    }
    return { version: data.version, error: null };
  } catch (e) {
    return {
      version: null,
      error: `npm registry unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/** Fetch latest version from GitHub Releases. */
async function fetchVersionFromGithub(): Promise<VersionFetchResult> {
  try {
    const resp = await fetch(GITHUB_API, {
      headers: { "User-Agent": "umans-gate-updater" },
    });
    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 429) {
        const reset = resp.headers.get("x-ratelimit-reset");
        const hint = reset
          ? ` (rate limit resets at ${new Date(Number(reset) * 1000).toISOString()})`
          : "";
        return {
          version: null,
          error: `GitHub API rate-limited (HTTP ${resp.status})${hint}`,
        };
      }
      return { version: null, error: `GitHub API returned HTTP ${resp.status}` };
    }
    const data = (await resp.json()) as GithubRelease;
    return { version: data.tag_name.replace(/^v/, ""), error: null };
  } catch (e) {
    return {
      version: null,
      error: `GitHub API unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

/**
 * Fetch the latest published version.
 *
 * Tries the npm registry first (authoritative for npm installs, not
 * rate-limited). Falls back to GitHub Releases so standalone-binary
 * updates can still resolve a version when npm is unreachable.
 *
 * Returns `{ version, error }` so callers can surface the real reason
 * on failure instead of a generic message.
 */
export async function fetchLatestVersion(): Promise<VersionFetchResult> {
  const npmResult = await fetchVersionFromNpm();
  if (npmResult.version) return npmResult;

  const ghResult = await fetchVersionFromGithub();
  if (ghResult.version) return ghResult;

  return {
    version: null,
    error: `npm registry: ${npmResult.error}; GitHub: ${ghResult.error}`,
  };
}

/** Fetch the full release data including assets. */
async function fetchLatestRelease(): Promise<{
  release: GithubRelease | null;
  error: string | null;
}> {
  try {
    const resp = await fetch(GITHUB_API, {
      headers: { "User-Agent": "umans-gate-updater" },
    });
    if (!resp.ok) {
      if (resp.status === 403 || resp.status === 429) {
        const reset = resp.headers.get("x-ratelimit-reset");
        const hint = reset
          ? ` (rate limit resets at ${new Date(Number(reset) * 1000).toISOString()})`
          : "";
        return {
          release: null,
          error: `GitHub API rate-limited (HTTP ${resp.status})${hint}`,
        };
      }
      return { release: null, error: `GitHub API returned HTTP ${resp.status}` };
    }
    return { release: (await resp.json()) as GithubRelease, error: null };
  } catch (e) {
    return {
      release: null,
      error: `GitHub API unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
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
export function compareVersions(a: string, b: string): number {
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
export async function downloadAndReplaceStandaloneBinary(_latestVersion: string): Promise<void> {
  const { release, error } = await fetchLatestRelease();
  if (!release) {
    console.error("Could not fetch release assets from GitHub.");
    if (error) console.error(`Reason: ${error}`);
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
  const { version: latest, error } = await fetchLatestVersion();
  if (!latest) {
    console.error("Could not fetch latest version.");
    if (error) console.error(`Reason: ${error}`);
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
  const { version: latest, error } = await fetchLatestVersion();
  if (!latest) {
    console.error("Could not fetch latest version.");
    if (error) console.error(`Reason: ${error}`);
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

// ---------------------------------------------------------------------------
// Version info cache + dashboard API support (ticket 01).
// ---------------------------------------------------------------------------

/** Cached version information exposed to the dashboard. */
export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  lastCheckedAt: number | null;
  error: string | null;
  /** Release notes (markdown) from the GitHub Release when `updateAvailable` is true, else `null`. */
  releaseNotes: string | null;
  canUpdate: boolean;
  /** `null` or `"no_service"`. */
  canUpdateReason: string | null;
}

let versionCache: VersionInfo | null = null;

/** Return the cached version info, or a default shape if never checked. */
export function getCachedVersionInfo(currentVersion: string): VersionInfo {
  if (versionCache) return versionCache;
  return {
    current: currentVersion,
    latest: null,
    updateAvailable: false,
    lastCheckedAt: null,
    error: null,
    releaseNotes: null,
    canUpdate: false,
    canUpdateReason: null,
  };
}

/**
 * Fetch the latest version, compare against `currentVersion`, update the cache.
 * `canUpdate` is true iff a service manager is installed.
 */
export async function refreshVersionCheck(currentVersion: string): Promise<VersionInfo> {
  const { version: latest, error } = await fetchLatestVersion();

  const updateAvailable = latest !== null && compareVersions(currentVersion, latest) < 0;

  let releaseNotes: string | null = null;
  if (updateAvailable) {
    const { release } = await fetchLatestRelease();
    if (release) {
      releaseNotes = release.body;
    }
  }

  const installed = await isServiceInstalled();
  const canUpdate = installed;
  const canUpdateReason: string | null = installed ? null : "no_service";

  versionCache = {
    current: currentVersion,
    latest,
    updateAvailable,
    lastCheckedAt: Date.now(),
    error,
    releaseNotes,
    canUpdate,
    canUpdateReason,
  };

  return versionCache;
}

/**
 * Resolve the umans-gate executable path (the CLI entry point).
 * Used to spawn a detached update process from inside the running proxy.
 */
function resolveUmansGateBin(): string | null {
  // Standalone compiled binary: process.execPath is the binary itself.
  const execPath = process.execPath;
  if (execPath.includes("umans-gate")) {
    return execPath;
  }

  // npm global install / dev mode: find the CLI shim on PATH.
  try {
    const which = spawnSync("which", ["umans-gate"], { encoding: "utf-8" });
    if (which.status === 0) {
      const p = which.stdout.trim();
      if (p && existsSync(p)) return p;
    }
  } catch {
    // `which` unavailable on Windows; fall through.
  }

  try {
    const where = spawnSync("where", ["umans-gate"], { encoding: "utf-8" });
    if (where.status === 0) {
      const p = where.stdout.trim().split("\n")[0]?.trim();
      if (p && existsSync(p)) return p;
    }
  } catch {
    // Not on Windows.
  }

  return null;
}

/**
 * Trigger the self-update from inside the running proxy process.
 *
 * This must NOT run stop/update/start inline — the proxy itself lives inside
 * the service manager's cgroup (systemd `KillMode=control-group`, launchd
 * process group, NSSM process tree). Calling `stopService()` from here would
 * SIGTERM this process before `performUpdate()` runs, leaving the system
 * stopped and unupdated (the documented bug).
 *
 * Instead, spawn the CLI's `update` command as a detached process that
 * escapes the service cgroup:
 * - systemd: `systemd-run --user --scope` creates a transient unit outside
 *   `umans-gate.service`'s cgroup.
 * - launchd: a detached spawn + `unref()` escapes the tracked process group.
 * - Windows/NSSM: a detached spawn escapes the parent process tree.
 *
 * The CLI `update` command already orchestrates stop → performUpdate → start
 * correctly from a separate process — we just run it from outside the
 * service cgroup so it survives the service stop.
 *
 * Returns `true` if the detached update process was spawned, `false` if the
 * binary could not be resolved.
 */
export function triggerSelfUpdate(): boolean {
  const bin = resolveUmansGateBin();
  if (!bin) {
    console.error("Could not resolve umans-gate binary for self-update.");
    return false;
  }

  const platformId = detectPlatform();

  try {
    if (platformId === "systemd") {
      // systemd-run --user --scope runs the command in a transient unit
      // that is NOT in the umans-gate.service cgroup. The process survives
      // when umans-gate.service is stopped.
      spawn("systemd-run", ["--user", "--scope", "--unit=umans-gate-self-update", bin, "update"], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else if (platformId === "launchd") {
      // launchd tracks processes by label (the LaunchAgent plist), not by
      // cgroup. A detached spawn escapes the parent's process group, and
      // launchd only restarts the labelled process — not arbitrary detached
      // children. `unref()` lets the parent (proxy) exit without waiting.
      spawn(bin, ["update"], {
        detached: true,
        stdio: "ignore",
      }).unref();
    } else {
      // Windows (NSSM) or unsupported: detached spawn escapes the parent
      // process tree. NSSM kills the service process tree on stop, but a
      // detached process is not part of that tree.
      spawn(bin, ["update"], {
        detached: true,
        stdio: "ignore",
        shell: platformId === "unsupported",
      }).unref();
    }
    return true;
  } catch (err) {
    console.error(
      `Failed to spawn detached self-update: ${err instanceof Error ? err.message : String(err)}`,
    );
    return false;
  }
}
