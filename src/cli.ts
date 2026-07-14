#!/usr/bin/env bun
// CLI entry point for umans-gate.
// Usage: bun src/cli.ts  (or after build: umans-gate)
// Point your harness base URL → http://localhost:1945
// Open the inspector → http://localhost:1945/dashboard/

import { Command } from "commander";
import pkg from "../package.json" with { type: "json" };
import { readConfigFile, resolveConfigPath } from "./config.js";
import { createProxyServer } from "./index.js";

const VERSION: string = pkg.version;

const program = new Command();

program
  .name("umans-gate")
  .description("LLM capture proxy with Anthropic cache_control TTL stamping")
  .version(VERSION)
  .option("--port <number>", "listen port")
  .option("--target <url>", "upstream target URL")
  .action((options) => {
    const config: Record<string, unknown> = {};
    if (options.port) config.port = Number(options.port);
    if (options.target) config.target = options.target;
    createProxyServer(Object.keys(config).length > 0 ? { config } : undefined);
  });

program
  .command("update")
  .description("Update umans-gate to the latest version")
  .option("--check", "check if update is available without installing")
  .action(async (options) => {
    const { checkForUpdate, performUpdate } = await import("./updater.js");
    const { isServiceInstalled, stopService, startService } = await import("./service/index.js");

    if (options.check) {
      await checkForUpdate(VERSION);
      return;
    }

    // Stop service before update if installed
    const serviceWasInstalled = await isServiceInstalled();
    if (serviceWasInstalled) {
      console.log("Stopping service before update...");
      await stopService();
    }

    await performUpdate(VERSION);

    // Restart service after update
    if (serviceWasInstalled) {
      console.log("Starting service after update...");
      await startService();
      console.log("✅ Service restarted after update.");
    }
  });

program
  .command("uninstall")
  .description("Remove umans-gate")
  .option("--keep-config", "keep configuration files")
  .action(async (options) => {
    const { isServiceInstalled, uninstallService } = await import("./service/index.js");

    // Stop and remove service first
    if (await isServiceInstalled()) {
      console.log("Removing service...");
      await uninstallService();
    }

    const { uninstall } = await import("./uninstaller.js");
    await uninstall({ keepConfig: options.keepConfig ?? false });
  });

program
  .command("config")
  .description("Show or edit configuration")
  .argument("[action]", "show | path")
  .action((action: string | undefined) => {
    const configPath = resolveConfigPath();
    if (action === "path") {
      console.log(configPath);
      return;
    }
    // Default: show
    const cfg = readConfigFile();
    console.log(JSON.stringify(cfg, null, 2));
    console.log(`\nConfig file: ${configPath}`);
  });

// --- service command group ---

const service = program.command("service").description("Manage the umans-gate background service");

service
  .command("install")
  .description("Install and start the background service (auto-starts on boot)")
  .option("--force", "overwrite existing service configuration")
  .action(async (options) => {
    const { installServiceCli } = await import("./service/index.js");
    await installServiceCli(options.force ?? false);
  });

service
  .command("uninstall")
  .description("Stop and remove the background service")
  .action(async () => {
    const { uninstallService } = await import("./service/index.js");
    await uninstallService();
  });

service
  .command("start")
  .description("Start the background service")
  .action(async () => {
    const { startService } = await import("./service/index.js");
    await startService();
  });

service
  .command("stop")
  .description("Stop the background service")
  .action(async () => {
    const { stopService } = await import("./service/index.js");
    await stopService();
  });

service
  .command("restart")
  .description("Restart the background service")
  .action(async () => {
    const { restartService } = await import("./service/index.js");
    await restartService();
  });

service
  .command("status")
  .description("Show service status")
  .action(async () => {
    const { statusService } = await import("./service/index.js");
    await statusService();
  });

service
  .command("logs")
  .description("Tail service logs")
  .option("-f, --follow", "follow log output")
  .action(async (options) => {
    const { tailServiceLogs } = await import("./service/index.js");
    await tailServiceLogs(options.follow ?? false);
  });

program.parse(process.argv);
