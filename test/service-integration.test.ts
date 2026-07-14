import { expect, test } from "bun:test";
import { resolveBinaryPath } from "../src/service/installer.js";
import type { InstallOptions, ServiceManager } from "../src/service/types.js";

test("resolveBinaryPath throws clear error when invoked via npx", () => {
  const origAgent = process.env.npm_config_user_agent;
  process.env.npm_config_user_agent = "npm/10.0.0 npx/10.0.0 node/v20.0.0";

  expect(() => resolveBinaryPath()).toThrow(/Cannot install service from npx/);
  expect(() => resolveBinaryPath()).toThrow(/npm install -g umans-gate/);

  process.env.npm_config_user_agent = origAgent;
});

test("resolveBinaryPath does not throw when npm_config_user_agent is absent", () => {
  const origAgent = process.env.npm_config_user_agent;
  process.env.npm_config_user_agent = undefined;

  const result = resolveBinaryPath();
  expect(typeof result).toBe("string");
  expect(result.length).toBeGreaterThan(0);

  process.env.npm_config_user_agent = origAgent;
});

test("installService calls manager.install with resolved options", async () => {
  const capturedOpts: InstallOptions[] = [];

  const mockManager: ServiceManager = {
    name: "mock",
    async install(opts: InstallOptions) {
      capturedOpts.push(opts);
      return {
        serviceFilePath: "/fake/path",
        message: "installed",
      };
    },
    async uninstall() {
      return { message: "uninstalled" };
    },
    async start() {},
    async stop() {},
    async restart() {},
    async status() {
      return { installed: false, running: false, statusLine: "mock" };
    },
    async isInstalled() {
      return false;
    },
    async tailLogs() {},
  };

  const { installService } = await import("../src/service/installer.js");

  const origApiKey = process.env.UMANS_API_KEY;
  process.env.UMANS_API_KEY = undefined;

  // Skip port validation — a running umans-gate instance may hold the port
  await installService(mockManager, false, async () => {});

  expect(capturedOpts.length).toBe(1);
  const opts = capturedOpts[0];
  expect(opts.force).toBe(false);
  expect(opts.binaryPath).toBeDefined();
  expect(opts.workingDir).toBeDefined();
  expect(opts.logDir).toContain("umans-gate");
  expect(opts.servicePath).toBeDefined();

  process.env.UMANS_API_KEY = origApiKey;
});
