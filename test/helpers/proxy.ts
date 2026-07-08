// Test helper: spawn the proxy server with given env overrides.
// Finds a free port, returns the process handle + the URL to connect to.

import { existsSync, unlinkSync } from "node:fs";
import { spawn } from "bun";
import type { Subprocess } from "bun";

export interface ProxyHandle {
  proc: Subprocess<"ignore", "ignore", "ignore">;
  port: number;
  baseUrl: string;
  dbPath: string;
  kill(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Find a free TCP port by binding to port 0. */
async function findFreePort(): Promise<number> {
  const { createServer } = await import("node:net");
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        reject(new Error("failed to find free port"));
      }
    });
    srv.on("error", reject);
  });
}

export interface StartProxyOptions {
  TARGET?: string;
  umansApiKey?: string;
  envOverrides?: Record<string, string>;
  proxyPort?: number;
  [key: string]: string | number | boolean | undefined | Record<string, string>;
}

export async function startProxy(options: StartProxyOptions = {}): Promise<ProxyHandle> {
  const { TARGET = "http://127.0.0.1:9099", umansApiKey, envOverrides = {}, proxyPort } = options;
  const port = proxyPort ?? (await findFreePort());
  const dbPath = `/tmp/umans-gate-test-${port}-${Date.now()}.db`;
  const extraEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(options)) {
    if (k === "TARGET" || k === "umansApiKey" || k === "envOverrides" || k === "proxyPort")
      continue;
    if (v !== undefined) extraEnv[k] = String(v);
  }

  const proc = spawn({
    cmd: ["bun", "src/cli.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      TARGET,
      PORT: String(port),
      DB_PATH: dbPath,
      UPSTREAM_PROTOCOL: "http1.1",
      USAGE_REFRESH_MS: "100",
      VISION_STRATEGY: "never",
      RELEASE_COOLDOWN_MS: "0",
      UMANS_API_KEY: umansApiKey ?? "",
      ...extraEnv,
      ...envOverrides,
    },
    stdout: "ignore",
    stderr: "ignore",
  });

  // Wait for the server to start listening
  await sleep(900);

  return {
    proc,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    dbPath,
    kill: async () => {
      proc.kill(9);
      await sleep(400);
      try {
        if (existsSync(dbPath)) unlinkSync(dbPath);
      } catch {
        // ignore
      }
    },
  };
}
