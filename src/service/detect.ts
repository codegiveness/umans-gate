// Platform detection: determines which service manager to use based on
// process.platform. Single responsibility — detection only, no side effects.

import { platform } from "node:os";
import type { PlatformId } from "./types.js";

/**
 * Detect which service manager is available on the current platform.
 * Returns "unsupported" for any platform without a known manager.
 */
export function detectPlatform(): PlatformId {
  switch (platform()) {
    case "linux":
      return "systemd";
    case "darwin":
      return "launchd";
    case "win32":
      return "windows-service";
    default:
      return "unsupported";
  }
}

/** Human-readable platform name for error messages. */
export function platformName(): string {
  switch (platform()) {
    case "linux":
      return "Linux";
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    default:
      return platform();
  }
}
