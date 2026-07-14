// Service module dispatcher.
// Detects the platform and delegates to the appropriate ServiceManager.
// This is the public API for the service module — the CLI calls these functions.

import { detectPlatform, platformName } from "./detect.js";
import { installService } from "./installer.js";
import { formatStatus } from "./status.js";
import type { ServiceManager } from "./types.js";

/** Lazy-loaded platform manager. Cached after first creation. */
let cachedManager: ServiceManager | null = null;

/**
 * Get the service manager for the current platform.
 * Throws if the platform is unsupported.
 */
export async function getManager(): Promise<ServiceManager> {
  if (cachedManager) return cachedManager;

  const platformId = detectPlatform();

  switch (platformId) {
    case "systemd": {
      const { SystemdManager } = await import("./systemd.js");
      cachedManager = SystemdManager;
      break;
    }
    case "launchd": {
      const { LaunchdManager } = await import("./launchd.js");
      cachedManager = LaunchdManager;
      break;
    }
    case "windows-service": {
      const { WindowsServiceManager } = await import("./windows-service.js");
      cachedManager = WindowsServiceManager;
      break;
    }
    default:
      throw new Error(
        `Service management is not supported on ${platformName()}. Supported platforms: Linux, macOS, Windows.`,
      );
  }

  return cachedManager;
}

// --- Public API functions called by cli.ts ---

export async function installServiceCli(force: boolean): Promise<void> {
  const manager = await getManager();
  await installService(manager, force);
}

export async function uninstallService(): Promise<void> {
  const manager = await getManager();
  const result = await manager.uninstall();
  console.log(`✅ ${result.message}`);
}

export async function startService(): Promise<void> {
  const manager = await getManager();
  if (!(await manager.isInstalled())) {
    console.error("Service is not installed. Run `umans-gate service install` first.");
    process.exit(1);
  }
  await manager.start();
  console.log("✅ Service started.");
}

export async function stopService(): Promise<void> {
  const manager = await getManager();
  if (!(await manager.isInstalled())) {
    console.error("Service is not installed.");
    process.exit(1);
  }
  await manager.stop();
  console.log("✅ Service stopped.");
}

export async function restartService(): Promise<void> {
  const manager = await getManager();
  if (!(await manager.isInstalled())) {
    console.error("Service is not installed. Run `umans-gate service install` first.");
    process.exit(1);
  }
  await manager.restart();
  console.log("✅ Service restarted.");
}

export async function statusService(): Promise<void> {
  const manager = await getManager();
  const status = await manager.status();
  console.log(formatStatus(status));
}

export async function tailServiceLogs(follow: boolean): Promise<void> {
  const manager = await getManager();
  if (!(await manager.isInstalled())) {
    console.error("Service is not installed. Run `umans-gate service install` first.");
    process.exit(1);
  }
  await manager.tailLogs(follow);
}

// --- Utility functions for updater.ts and uninstaller.ts integration ---

export async function isServiceInstalled(): Promise<boolean> {
  try {
    const manager = await getManager();
    return manager.isInstalled();
  } catch {
    // Unsupported platform
    return false;
  }
}
