// Uninstall logic for umans-gate.
// Removes the standalone binary, npm global package, and optionally config files.

import { execSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveConfigPath } from "./config.js";

interface UninstallOptions {
  keepConfig: boolean;
}

/** Check if running as a compiled standalone executable. */
function isCompiledExecutable(): boolean {
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

/** Remove the standalone executable binary. */
function removeStandaloneBinary(): void {
  const execPath = process.execPath;
  if (existsSync(execPath) && execPath.includes("umans-gate")) {
    const dir = dirname(execPath);
    try {
      rmSync(execPath);
      console.log(`Removed binary: ${execPath}`);
      // Remove symlink if exists (e.g. in /usr/local/bin)
      const symlinkPath = join("/usr/local/bin", "umans-gate");
      if (existsSync(symlinkPath)) {
        rmSync(symlinkPath);
        console.log(`Removed symlink: ${symlinkPath}`);
      }
      // If the binary directory is now empty, remove it
      const { readdirSync, rmdirSync } = require("node:fs");
      if (readdirSync(dir).length === 0) {
        rmdirSync(dir);
        console.log(`Removed empty directory: ${dir}`);
      }
    } catch (err) {
      console.error(`Failed to remove binary: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Remove the npm global package. */
function removeNpmGlobal(): void {
  try {
    execSync("npm uninstall -g umans-gate", { stdio: "inherit" });
    console.log("Removed npm global package: umans-gate");
  } catch {
    console.error("Failed to uninstall npm package. Try: npm uninstall -g umans-gate");
  }
}

/** Remove configuration files. */
function removeConfig(): void {
  const configPath = resolveConfigPath();
  if (existsSync(configPath)) {
    try {
      rmSync(configPath);
      console.log(`Removed config: ${configPath}`);
    } catch (err) {
      console.error(`Failed to remove config: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log("No config file found.");
  }
}

/** Perform the uninstall based on install method and options. */
export async function uninstall(options: UninstallOptions): Promise<void> {
  console.log("Uninstalling umans-gate...\n");

  let removed = false;

  if (isNpmGlobal()) {
    console.log("Install method: npm global");
    removeNpmGlobal();
    removed = true;
  }

  if (isCompiledExecutable()) {
    console.log("Install method: standalone executable");
    removeStandaloneBinary();
    removed = true;
  }

  if (!removed) {
    console.log("No global installation found.");
    console.log("If running from source, simply delete the project directory.");
  }

  if (!options.keepConfig) {
    console.log("\nRemoving configuration...");
    removeConfig();
  } else {
    console.log("\nKeeping configuration files (--keep-config).");
  }

  console.log("\nUninstall complete.");
}
