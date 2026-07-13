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
    if (options.check) {
      await checkForUpdate(VERSION);
    } else {
      await performUpdate(VERSION);
    }
  });

program
  .command("uninstall")
  .description("Remove umans-gate")
  .option("--keep-config", "keep configuration files")
  .action(async (options) => {
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

program.parse(process.argv);
