// Config path resolution (cross-OS):
//   Linux/macOS: $XDG_CONFIG_HOME/umans-gate/config.json  or  ~/.config/umans-gate/config.json
//   Windows:     %APPDATA%/umans-gate/config.json

import { homedir, platform } from "node:os";
import { join } from "node:path";

/** Resolve the config directory path following OS conventions. */
export function resolveConfigDir(): string {
  const p = platform();
  if (p === "win32") {
    const appData = process.env.APPDATA ?? join(homedir(), "AppData", "Roaming");
    return join(appData, "umans-gate");
  }
  // Linux, macOS, and fallback.
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(base, "umans-gate");
}

/** Resolve the config file path (JSON single source of truth). */
export function resolveConfigPath(): string {
  return join(resolveConfigDir(), "config.json");
}
