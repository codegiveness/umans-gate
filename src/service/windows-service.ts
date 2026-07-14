// Windows Service management via NSSM (Non-Sucking Service Manager).
// NSSM is bundled in the Windows platform packages, providing full crash
// recovery and auto-start on boot without any external dependencies.

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { nssmCommands } from "./templates.js";
import type {
  InstallOptions,
  InstallResult,
  ServiceManager,
  ServiceStatus,
  UninstallResult,
} from "./types.js";

const SERVICE_NAME = "umans-gate";

/**
 * Resolve the NSSM executable path.
 *
 * NSSM is bundled alongside the standalone binary in win32 platform packages.
 * `process.execPath` points to the standalone binary itself (not node.exe),
 * because the npm package ships a pre-compiled `bun build --compile` binary.
 */
function nssmPath(): string {
  return join(dirname(process.execPath), "nssm.exe");
}

/** Run nssm with the given arguments, returning stdout. */
function nssm(args: string[]): string {
  return execFileSync(nssmPath(), args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Run nssm, returning true if exit code 0. */
function nssmOk(args: string[]): boolean {
  try {
    execFileSync(nssmPath(), args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Run sc.exe with the given arguments. */
function sc(args: string[]): string {
  return execFileSync("sc.exe", args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

/** Run sc.exe, returning true if exit code 0. */
function scOk(args: string[]): boolean {
  try {
    execFileSync("sc.exe", args, {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

/** Resolve the log directory for Windows. */
function winLogDir(): string {
  const appData =
    process.env.APPDATA ??
    join(process.env.USERPROFILE ?? "C:\\Users\\Public", "AppData", "Roaming");
  return join(appData, "umans-gate", "logs");
}

/** Check if the service exists in the Windows Service Control Manager. */
function serviceExists(): boolean {
  try {
    const output = sc(["query", SERVICE_NAME]);
    return output.includes(SERVICE_NAME);
  } catch {
    return false;
  }
}

export const WindowsServiceManager: ServiceManager = {
  name: "windows-service",

  async install(opts: InstallOptions): Promise<InstallResult> {
    // Ensure log directory exists
    mkdirSync(opts.logDir, { recursive: true });

    // Idempotency: check if service already exists
    if (!opts.force && serviceExists()) {
      return {
        serviceFilePath: "",
        message: "Service already installed. Use `umans-gate service restart` or `--force`.",
      };
    }

    // If force, remove existing service first
    if (opts.force && serviceExists()) {
      nssmOk(["stop", SERVICE_NAME]);
      nssmOk(["remove", SERVICE_NAME, "confirm"]);
      // Wait for removal to complete
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    // Run the NSSM command sequence
    const commands = nssmCommands(SERVICE_NAME, opts);
    for (const [cmd, ...args] of commands) {
      if (cmd === "nssm") {
        nssm([...args]);
      }
    }

    // Start the service
    sc(["start", SERVICE_NAME]);

    return {
      serviceFilePath: "",
      message: "Service installed, enabled (SERVICE_AUTO_START), and started.",
    };
  },

  async uninstall(): Promise<UninstallResult> {
    if (!serviceExists()) {
      return { message: "Service not installed." };
    }

    // Stop and remove
    nssmOk(["stop", SERVICE_NAME]);
    nssmOk(["remove", SERVICE_NAME, "confirm"]);

    return { message: "Service stopped and removed." };
  },

  async start(): Promise<void> {
    if (!serviceExists()) {
      throw new Error("Service not installed. Run `umans-gate service install` first.");
    }
    sc(["start", SERVICE_NAME]);
  },

  async stop(): Promise<void> {
    scOk(["stop", SERVICE_NAME]);
  },

  async restart(): Promise<void> {
    scOk(["stop", SERVICE_NAME]);
    // Wait for stop to complete
    await new Promise((resolve) => setTimeout(resolve, 2000));
    sc(["start", SERVICE_NAME]);
  },

  async status(): Promise<ServiceStatus> {
    if (!serviceExists()) {
      return {
        installed: false,
        running: false,
        statusLine: "not installed",
      };
    }

    try {
      const output = sc(["query", SERVICE_NAME]);
      const running = output.includes("RUNNING");
      const stopped = output.includes("STOPPED");

      let pid: number | undefined;
      try {
        const pidOutput = nssm(["get", SERVICE_NAME, "Process"]);
        pid = Number.parseInt(pidOutput.trim(), 10);
        if (Number.isNaN(pid) || pid <= 0) pid = undefined;
      } catch {
        // PID query may fail if not running
      }

      return {
        installed: true,
        running,
        pid,
        statusLine: running ? "running" : stopped ? "stopped" : "unknown",
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
    return serviceExists();
  },

  async tailLogs(follow: boolean): Promise<void> {
    const logFile = join(winLogDir(), "umans-gate.log");
    if (!existsSync(logFile)) {
      console.error(`No log file found at ${logFile}`);
      return;
    }

    // On Windows, use PowerShell Get-Content -Tail/-Wait
    if (follow) {
      const child = spawn(
        "powershell",
        ["-NoProfile", "-Command", `Get-Content -Wait -Path '${logFile}'`],
        {
          stdio: "inherit",
          shell: "cmd.exe",
        },
      );
      child.on("exit", (code) => {
        if (code !== 0) process.exit(code ?? 0);
      });
    } else {
      execFileSync(
        "powershell",
        ["-NoProfile", "-Command", `Get-Content -Tail 100 -Path '${logFile}'`],
        {
          stdio: "inherit",
        },
      );
    }
  },
};
