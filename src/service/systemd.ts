// Linux systemd user-unit service manager.
// Manages the umans-gate.service user unit in ~/.config/systemd/user/.
// Uses enable-linger for boot-start without login.

import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { renderEnvFile, renderSystemdUnit } from "./templates.js";
import type {
  InstallOptions,
  InstallResult,
  ServiceManager,
  ServiceStatus,
  UninstallResult,
} from "./types.js";

const SERVICE_NAME = "umans-gate";
const UNIT_FILENAME = "umans-gate.service";

/** Path to the user systemd unit directory. */
function unitDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

/** Path to the unit file. */
function unitPath(): string {
  return join(unitDir(), UNIT_FILENAME);
}

/** Path to the env file for EnvironmentFile (alongside config.json). */
function envFilePath(): string {
  return join(homedir(), ".config", "umans-gate", "service.env");
}

/** Run a systemctl --user command, returning stdout. Throws on failure. */
function systemctl(args: string[]): string {
  return execFileSync("systemctl", ["--user", ...args], {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Run a systemctl --user command, returning true if exit code 0. */
function systemctlOk(args: string[]): boolean {
  try {
    execFileSync("systemctl", ["--user", ...args], {
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

export const SystemdManager: ServiceManager = {
  name: "systemd",

  async install(opts: InstallOptions): Promise<InstallResult> {
    const path = unitPath();

    // Idempotency: check if already installed
    if (!opts.force && existsSync(path)) {
      return {
        serviceFilePath: path,
        message: "Service already installed. Use `umans-gate service restart` or `--force`.",
      };
    }

    // Write env file if API key is provided via env (not config.json)
    if (opts.apiKey) {
      const envFile = envFilePath();
      atomicWrite(envFile, renderEnvFile(opts.apiKey));
      try {
        chmodSync(envFile, 0o600);
      } catch {
        // Best-effort
      }
    }

    // Write unit file atomically
    const unitContent = renderSystemdUnit(opts);
    atomicWrite(path, unitContent);

    // Reload systemd, enable, and start
    systemctl(["daemon-reload"]);
    systemctl(["enable", `${SERVICE_NAME}.service`]);
    systemctl(["start", `${SERVICE_NAME}.service`]);

    // Enable linger so the service starts on boot without login
    try {
      execFileSync("loginctl", ["enable-linger", process.env.USER ?? ""], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      // enable-linger may need root on some systems; warn but don't fail
      console.warn(
        "Warning: could not enable linger. Service will start on login but may not auto-start on boot.",
      );
    }

    return {
      serviceFilePath: path,
      message: "Service installed, enabled, and started. Auto-start on boot enabled (linger).",
    };
  },

  async uninstall(): Promise<UninstallResult> {
    const path = unitPath();

    if (!existsSync(path)) {
      return { message: "Service not installed." };
    }

    // Stop and disable
    systemctlOk(["stop", `${SERVICE_NAME}.service`]);
    systemctlOk(["disable", `${SERVICE_NAME}.service`]);

    // Remove unit file
    const { rmSync } = await import("node:fs");
    rmSync(path);

    // Remove env file if it exists
    const envFile = envFilePath();
    if (existsSync(envFile)) {
      rmSync(envFile);
    }

    // Reload daemon
    systemctl(["daemon-reload"]);

    return { message: "Service stopped, disabled, and removed." };
  },

  async start(): Promise<void> {
    systemctl(["start", `${SERVICE_NAME}.service`]);
  },

  async stop(): Promise<void> {
    systemctl(["stop", `${SERVICE_NAME}.service`]);
  },

  async restart(): Promise<void> {
    systemctl(["restart", `${SERVICE_NAME}.service`]);
  },

  async status(): Promise<ServiceStatus> {
    if (!existsSync(unitPath())) {
      return {
        installed: false,
        running: false,
        statusLine: "not installed",
      };
    }

    try {
      const output = systemctl(["show", `${SERVICE_NAME}.service`]);
      const props = parseSystemctlShow(output);
      const activeState = props.ActiveState ?? "unknown";
      const subState = props.SubState ?? "";
      const running = activeState === "active";

      let pid: number | undefined;
      if (props.MainPID) {
        pid = Number.parseInt(props.MainPID, 10);
      }

      let uptimeMs: number | undefined;
      if (props.ExecMainStartTimestamp) {
        const startTime = Number.parseInt(props.ExecMainStartTimestamp, 10);
        // systemd timestamps are in microseconds since epoch
        uptimeMs = Date.now() - startTime / 1000;
      }

      return {
        installed: true,
        running,
        pid: pid && pid > 0 ? pid : undefined,
        uptimeMs: uptimeMs && uptimeMs > 0 ? uptimeMs : undefined,
        lastExitCode: props.ExecMainStatus ? Number.parseInt(props.ExecMainStatus, 10) : undefined,
        statusLine: `${activeState} (${subState})`,
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
    return existsSync(unitPath());
  },

  async tailLogs(follow: boolean): Promise<void> {
    const logDir = join(homedir(), ".config", "umans-gate", "logs");
    const logFile = join(logDir, "umans-gate.log");

    // If we have our own log file, tail it. Otherwise fall back to journalctl.
    if (existsSync(logFile)) {
      const args = follow ? ["-f", logFile] : ["-n", "100", logFile];
      const child = spawn("tail", args, { stdio: "inherit" });
      // Keep the process alive for follow mode
      if (follow) {
        child.on("exit", (code) => {
          if (code !== 0) process.exit(code ?? 0);
        });
      }
      return;
    }

    // Fall back to journalctl
    const args = follow
      ? ["--user", "-f", "-u", `${SERVICE_NAME}.service`]
      : ["--user", "-n", "100", "-u", `${SERVICE_NAME}.service`];
    const child = spawn("journalctl", args, { stdio: "inherit" });
    if (follow) {
      child.on("exit", (code) => {
        if (code !== 0) process.exit(code ?? 0);
      });
    }
  },
};

/** Parse `systemctl --user show` output into a key=value map. */
function parseSystemctlShow(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) {
      const key = line.slice(0, idx);
      const value = line.slice(idx + 1);
      result[key] = value;
    }
  }
  return result;
}
