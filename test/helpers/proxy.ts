import { existsSync, rmSync, unlinkSync } from "node:fs";
import type { Subprocess } from "bun";
import { spawn } from "bun";

export interface ProxyHandle {
  proc: Subprocess<"ignore", "ignore", "pipe">;
  port: number;
  baseUrl: string;
  dbPath: string;
  kill(): Promise<void>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
  dashboardToken?: string;
  envOverrides?: Record<string, string>;
  proxyPort?: number;
  [key: string]: string | number | boolean | undefined | Record<string, string>;
}

export async function startProxy(options: StartProxyOptions = {}): Promise<ProxyHandle> {
  const {
    TARGET = "http://127.0.0.1:9099",
    umansApiKey,
    dashboardToken,
    envOverrides = {},
    proxyPort,
  } = options;
  const port = proxyPort ?? (await findFreePort());
  const dbPath = `/tmp/umans-gate-test-${port}-${Date.now()}.db`;
  const configHome = `/tmp/umans-gate-test-config-${port}-${Date.now()}`;
  const extraEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(options)) {
    if (
      k === "TARGET" ||
      k === "umansApiKey" ||
      k === "dashboardToken" ||
      k === "envOverrides" ||
      k === "proxyPort"
    )
      continue;
    if (v !== undefined) extraEnv[k] = String(v);
  }

  const proc = spawn({
    cmd: ["bun", "src/cli.ts"],
    cwd: process.cwd(),
    env: {
      ...process.env,
      XDG_CONFIG_HOME: configHome,
      TARGET,
      PORT: String(port),
      DB_PATH: dbPath,
      UPSTREAM_PROTOCOL: "http1.1",
      USAGE_REFRESH_MS: "100",
      VISION_STRATEGY: "never",
      RELEASE_COOLDOWN_MS: "0",
      STAMP_CLAUDE_CODE_ENABLED: "false",
      STAMP_REASONING_EFFORT_ENABLED: "false",
      UMANS_API_KEY: umansApiKey ?? "",
      DASHBOARD_TOKEN: dashboardToken ?? "",
      ...extraEnv,
      ...envOverrides,
    },
    stdout: "ignore",
    stderr: "pipe",
  });

  const healthUrl = `http://127.0.0.1:${port}/health`;
  const healthHeaders: Record<string, string> = {};
  if (dashboardToken) {
    healthHeaders.Authorization = `Bearer ${dashboardToken}`;
  }
  let started = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      const res = await fetch(healthUrl, { headers: healthHeaders });
      if (res.ok) {
        started = true;
        break;
      }
    } catch {
      await sleep(20);
    }
  }
  if (!started) {
    let errOutput = "";
    try {
      errOutput = await new Response(proc.stderr).text();
    } catch {
      // stderr already consumed or unavailable
    }
    throw new Error(
      `Proxy server did not start within 1s on port ${port}. stderr: ${errOutput.slice(0, 500)}`,
    );
  }

  return {
    proc,
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    dbPath,
    kill: async () => {
      proc.kill(9);
      await sleep(150);
      try {
        if (existsSync(dbPath)) unlinkSync(dbPath);
      } catch {
        // ignore
      }
      try {
        if (existsSync(configHome)) rmSync(configHome, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}
