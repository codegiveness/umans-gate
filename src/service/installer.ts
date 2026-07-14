// Service installer orchestrator.
// Resolves install variables, validates config, and delegates to the
// platform-specific ServiceManager. Single responsibility: orchestration.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { readConfigFile, validateConfig } from "../config.js";
import { resolveLogDir } from "./status.js";
import type { InstallOptions, ServiceManager } from "./types.js";

/**
 * Resolve the PATH that the service should use.
 *
 * systemd user units and launchd LaunchAgents have a minimal PATH that often
 * doesn't include the directories where `bun` or `node` are installed
 * (e.g. `~/.bun/bin`, `~/.nvm/versions/...`, Homebrew paths).
 *
 * This function takes the current process PATH and prepends common runtime
 * locations so the shebang `#!/usr/bin/env bun` (or `node`) can resolve.
 */
export function resolveServicePath(): string {
  const home = homedir();
  const isWindows = process.platform === "win32";
  const sep = isWindows ? ";" : ":";

  const commonDirs = isWindows
    ? [
        `${home}\\.bun\\bin`,
        `${home}\\.local\\bin`,
        "C:\\Program Files\\nodejs",
        "C:\\Program Files (x86)\\nodejs",
      ]
    : [
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        `${home}/.bun/bin`,
        `${home}/.local/bin`,
        "/opt/homebrew/bin",
        "/usr/local/sbin",
      ];

  const currentPath = process.env.PATH ?? "";
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const dir of [...commonDirs, ...currentPath.split(sep)]) {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      parts.push(dir);
    }
  }

  return parts.join(sep);
}

/**
 * Resolve the binary path for the service ExecStart.
 *
 * For npm global installs: points to the npm global symlink (`which umans-gate`),
 * which survives npm updates (the shim resolves the actual binary at runtime).
 * For standalone installs: points to process.execPath directly.
 * Throws on npx invocation (npx doesn't install globally, so a service can't
 * point to it).
 */
export function resolveBinaryPath(): string {
  // Detect npx invocation first — npx doesn't install globally, so a
  // service can't point to it. Check before everything else so the error
  // is surfaced even if umans-gate happens to be globally installed.
  if (process.env.npm_config_user_agent?.includes("npx")) {
    throw new Error(
      "Cannot install service from npx. Install umans-gate globally first:\n" +
        "  npm install -g umans-gate\n" +
        "Then run: umans-gate service install",
    );
  }

  // If running as a compiled standalone binary, use it directly
  const execPath = process.execPath;
  if (execPath.includes("umans-gate")) {
    return execPath;
  }

  // For npm global installs, try to find the symlink on PATH
  try {
    const which = spawnSync("which", ["umans-gate"], { encoding: "utf-8" });
    if (which.status === 0) {
      const symlinkPath = which.stdout.trim();
      if (symlinkPath.length > 0 && existsSync(symlinkPath)) {
        return symlinkPath;
      }
    }
  } catch {
    // which not available on Windows; fall through to where
  }

  // Windows fallback
  try {
    const where = spawnSync("where", ["umans-gate"], { encoding: "utf-8" });
    if (where.status === 0) {
      const symlinkPath = where.stdout.trim().split("\n")[0]?.trim();
      if (symlinkPath && symlinkPath.length > 0 && existsSync(symlinkPath)) {
        return symlinkPath;
      }
    }
  } catch {
    // Not on Windows
  }

  // Fallback: use the current process execPath
  return execPath;
}

/**
 * Resolve the working directory for the service.
 * Defaults to the user's home directory.
 */
export function resolveWorkingDir(): string {
  return homedir();
}

/**
 * Validate config and check port availability before installing the service.
 * Throws if config is invalid or port is in use.
 */
export async function validateBeforeInstall(): Promise<void> {
  // Read and validate config
  const rawConfig = readConfigFile();
  const validation = validateConfig(rawConfig);

  if (!validation.ok) {
    console.error("Config validation failed:");
    for (const err of validation.errors) {
      console.error(`  ${err}`);
    }
    throw new Error("Config validation failed");
  }

  const port = validation.normalized.port ?? 1945;

  await new Promise<void>((resolve, reject) => {
    const testServer = createServer();
    testServer.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${port} is already in use. Change it in config.json first.`));
      } else {
        reject(err);
      }
    });
    testServer.listen(port, "127.0.0.1", () => {
      testServer.close(() => resolve());
    });
  });

  // Warn about relative db_path
  const dbPath = validation.normalized.db_path ?? "./umans-gate.db";
  if (!dbPath.startsWith("/")) {
    const workingDir = resolveWorkingDir();
    console.warn(
      `Warning: db_path is relative (${dbPath}). Database will be at ${workingDir}/${dbPath}. Use an absolute path in config.json if you want it elsewhere.`,
    );
  }
}

/**
 * Resolve the API key. Prefer config.json; only use env if config is empty.
 */
export function resolveApiKey(): string | undefined {
  const rawConfig = readConfigFile();
  const configKey = rawConfig.umans_api_key;

  if (configKey && configKey.length > 0) {
    // Key is in config.json — service will read it. No env var needed.
    return undefined;
  }

  // Key not in config; check env
  const envKey = process.env.UMANS_API_KEY;
  if (envKey && envKey.length > 0) {
    return envKey;
  }

  return undefined;
}

/**
 * Orchestrated install: validate → resolve variables → call manager.install().
 */
export async function installService(
  manager: ServiceManager,
  force: boolean,
  validate: () => Promise<void> = validateBeforeInstall,
): Promise<void> {
  // Validate config before writing service files
  await validate();

  // Resolve install variables
  const binaryPath = resolveBinaryPath();
  const workingDir = resolveWorkingDir();
  const apiKey = resolveApiKey();
  const logDir = resolveLogDir();

  // Ensure log directory exists
  mkdirSync(logDir, { recursive: true });

  const opts: InstallOptions = {
    binaryPath,
    workingDir,
    apiKey,
    logDir,
    force,
    servicePath: resolveServicePath(),
  };

  const result = await manager.install(opts);
  console.log(`✅ ${result.message}`);
  console.log("📁 Config: ~/.config/umans-gate/config.json");
  console.log(`📁 Logs: ${logDir}`);
  console.log("🔗 Dashboard: http://localhost:1945/dashboard/");
}
