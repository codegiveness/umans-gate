// Cross-platform status formatting and log path helpers.
// Used by the CLI dispatcher to display service status uniformly.

import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { ServiceStatus } from "./types.js";

/** Resolve the log directory for the current platform. */
export function resolveLogDir(): string {
  const p = platform();
  if (p === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "umans-gate", "logs");
  }
  // Linux, macOS, and fallback
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "umans-gate", "logs");
}

/** Format uptime from milliseconds to human-readable string. */
export function formatUptime(uptimeMs: number): string {
  const seconds = Math.floor(uptimeMs / 1000);
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${secs}s`;
  return `${secs}s`;
}

/** Format service status for CLI display. */
export function formatStatus(status: ServiceStatus): string {
  if (!status.installed) {
    return "Service: not installed";
  }

  const lines: string[] = [];
  lines.push(`Service: installed, ${status.running ? "running" : "not running"}`);

  if (status.pid) {
    lines.push(`PID: ${status.pid}`);
  }

  if (status.uptimeMs !== undefined && status.uptimeMs > 0) {
    lines.push(`Uptime: ${formatUptime(status.uptimeMs)}`);
  }

  if (status.lastExitCode !== undefined) {
    lines.push(`Last exit code: ${status.lastExitCode}`);
  }

  lines.push(`Status: ${status.statusLine}`);

  return lines.join("\n");
}
