// macOS launchd LaunchAgent service manager.
// Manages com.umans.gate.plist in ~/Library/LaunchAgents/.
// RunAtLoad starts on login; KeepAlive provides crash recovery.

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { renderLaunchdPlist } from "./templates.js";
import type {
  InstallOptions,
  InstallResult,
  ServiceManager,
  ServiceStatus,
  UninstallResult,
} from "./types.js";

const LABEL = "com.umans.gate";
const PLIST_FILENAME = "com.umans.gate.plist";

/** Path to the LaunchAgents directory. */
function agentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

/** Path to the plist file. */
function plistPath(): string {
  return join(agentsDir(), PLIST_FILENAME);
}

/** Path to the log directory. */
function logDir(): string {
  return join(homedir(), ".config", "umans-gate", "logs");
}

/** Run a launchctl command, returning stdout. Throws on failure. */
function launchctl(args: string[]): string {
  return execFileSync("launchctl", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Run a launchctl command, returning true if exit code 0. */
function launchctlOk(args: string[]): boolean {
  try {
    execFileSync("launchctl", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Write a file atomically: temp file + rename. */
function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path);
}

export const LaunchdManager: ServiceManager = {
  name: "launchd",

  async install(opts: InstallOptions): Promise<InstallResult> {
    const path = plistPath();

    // Idempotency
    if (!opts.force && existsSync(path)) {
      return {
        serviceFilePath: path,
        message: "Service already installed. Use `umans-gate service restart` or `--force`.",
      };
    }

    // Ensure log directory exists
    mkdirSync(logDir(), { recursive: true });

    // Write plist atomically
    const plistContent = renderLaunchdPlist(opts);
    atomicWrite(path, plistContent);

    if (opts.apiKey) {
      chmodSync(path, 0o600);
    }

    // Unload if already loaded, then load fresh
    launchctlOk(["unload", path]);
    launchctl(["load", path]);

    // Start the service
    launchctl(["start", LABEL]);

    return {
      serviceFilePath: path,
      message: "Service installed and started. Auto-start on boot enabled (RunAtLoad).",
    };
  },

  async uninstall(): Promise<UninstallResult> {
    const path = plistPath();

    if (!existsSync(path)) {
      return { message: "Service not installed." };
    }

    // Stop and unload
    launchctlOk(["unload", path]);

    // Remove plist file
    const { rmSync } = await import("node:fs");
    rmSync(path);

    return { message: "Service stopped and removed." };
  },

  async start(): Promise<void> {
    const path = plistPath();
    if (!existsSync(path)) {
      throw new Error("Service not installed. Run `umans-gate service install` first.");
    }
    // If not loaded, load it
    launchctlOk(["load", path]);
    launchctl(["start", LABEL]);
  },

  async stop(): Promise<void> {
    // Use unload (not stop) so KeepAlive=true doesn't immediately restart
    launchctlOk(["unload", plistPath()]);
  },

  async restart(): Promise<void> {
    // Unload (stops + prevents KeepAlive restart), then reload to start fresh
    launchctlOk(["unload", plistPath()]);
    launchctlOk(["load", plistPath()]);
    launchctl(["start", LABEL]);
  },

  async status(): Promise<ServiceStatus> {
    if (!existsSync(plistPath())) {
      return {
        installed: false,
        running: false,
        statusLine: "not installed",
      };
    }

    try {
      // `launchctl list` returns: PID, Status, Label
      const output = launchctl(["list"]);
      const line = output.split("\n").find((l) => l.includes(LABEL));

      if (!line) {
        return {
          installed: true,
          running: false,
          statusLine: "loaded but not running",
        };
      }

      const parts = line.trim().split(/\s+/);
      const pidStr = parts[0] ?? "";
      const statusStr = parts[1] ?? "";
      const pid = pidStr !== "-" && pidStr !== "" ? Number.parseInt(pidStr, 10) : undefined;
      const exitCode =
        statusStr !== "-" && statusStr !== "" ? Number.parseInt(statusStr, 10) : undefined;
      const running = pid !== undefined && pid > 0;

      return {
        installed: true,
        running,
        pid,
        lastExitCode: exitCode,
        statusLine: running ? `running (PID ${pid})` : "not running",
      };
    } catch {
      return {
        installed: true,
        running: false,
        statusLine: "error querying status",
      };
    }
  },

  async isInstalled(): Promise<boolean> {
    return existsSync(plistPath());
  },

  async tailLogs(follow: boolean): Promise<void> {
    const logFile = join(logDir(), "umans-gate.log");
    if (!existsSync(logFile)) {
      console.error(`No log file found at ${logFile}`);
      return;
    }

    const args = follow ? ["-f", logFile] : ["-n", "100", logFile];
    const child = spawn("tail", args, { stdio: "inherit" });
    if (follow) {
      child.on("exit", (code) => {
        if (code !== 0) process.exit(code ?? 0);
      });
    }
  },
};
