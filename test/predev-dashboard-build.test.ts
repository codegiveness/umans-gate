import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ProxyHandle, startProxy } from "./helpers/proxy";

const ROOT = process.cwd();
const DASHBOARD_DIST = join(ROOT, "dashboard", "dist");
const EMBEDDED_ASSETS = join(ROOT, "src", "embedded-assets.ts");
const BACKUP_DIR = join(tmpdir(), "predev-test-backup");

/**
 * Regression test for the `predev` dashboard build guard.
 *
 * When `dashboard/dist/` or `src/embedded-assets.ts` is missing,
 * `bun run predev` must rebuild both so that `bun run dev` (which spawns
 * `bun src/cli.ts`) can start the server and serve the dashboard.
 *
 * Test seam: spawn the proxy via test/helpers/proxy.ts and assert
 * `GET /dashboard/` returns HTML 200. This is the highest possible seam —
 * it tests the user-visible outcome (dashboard is served) without
 * testing npm/bun script-runner internals.
 *
 * Backup strategy uses cpSync (copy) not renameSync (move) so that
 * parallel test files that need `dashboard/dist/` are unaffected.
 */

describe("predev dashboard build guard", () => {
  let proxy: ProxyHandle;

  beforeAll(() => {
    // Copy existing build artifacts so parallel tests are unaffected.
    mkdirSync(BACKUP_DIR, { recursive: true });
    if (existsSync(DASHBOARD_DIST)) {
      cpSync(DASHBOARD_DIST, join(BACKUP_DIR, "dist"), { recursive: true });
      rmSync(DASHBOARD_DIST, { recursive: true, force: true });
    }
    if (existsSync(EMBEDDED_ASSETS)) {
      cpSync(EMBEDDED_ASSETS, join(BACKUP_DIR, "embedded-assets.ts"));
      rmSync(EMBEDDED_ASSETS, { force: true });
    }
  });

  afterEach(() => {
    // Clean any artifacts produced by predev between tests.
    rmSync(DASHBOARD_DIST, { recursive: true, force: true });
    rmSync(EMBEDDED_ASSETS, { force: true });
  });

  afterAll(async () => {
    // Restore original build artifacts (copy back, then remove backup).
    rmSync(DASHBOARD_DIST, { recursive: true, force: true });
    rmSync(EMBEDDED_ASSETS, { force: true });
    const backupDist = join(BACKUP_DIR, "dist");
    const backupAssets = join(BACKUP_DIR, "embedded-assets.ts");
    if (existsSync(backupDist)) {
      cpSync(backupDist, DASHBOARD_DIST, { recursive: true });
    }
    if (existsSync(backupAssets)) {
      cpSync(backupAssets, EMBEDDED_ASSETS);
    }
    rmSync(BACKUP_DIR, { recursive: true, force: true });
  });

  test("predev rebuilds dashboard/dist/ and embedded-assets.ts when both are missing", async () => {
    // Both artifacts are absent (cleaned by afterEach or beforeAll).
    expect(existsSync(join(DASHBOARD_DIST, "index.html"))).toBe(false);
    expect(existsSync(EMBEDDED_ASSETS)).toBe(false);

    // Run predev — should build both.
    const proc = Bun.spawn(["bun", "run", "predev"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    // Verify both artifacts exist.
    expect(existsSync(join(DASHBOARD_DIST, "index.html"))).toBe(true);
    expect(existsSync(EMBEDDED_ASSETS)).toBe(true);
  });

  test("predev skips dashboard build when index.html already exists", async () => {
    const buildProc = Bun.spawn(["bun", "run", "predev"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    await buildProc.exited;

    expect(existsSync(join(DASHBOARD_DIST, "index.html"))).toBe(true);
    expect(existsSync(EMBEDDED_ASSETS)).toBe(true);

    const mtimeBefore = statSync(EMBEDDED_ASSETS).mtimeMs;

    // Brief delay so mtime difference is detectable (filesystem mtime granularity).
    await new Promise((r) => setTimeout(r, 50));

    const proc = Bun.spawn(["bun", "run", "predev"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    expect(exitCode).toBe(0);

    expect(existsSync(join(DASHBOARD_DIST, "index.html"))).toBe(true);
    expect(existsSync(EMBEDDED_ASSETS)).toBe(true);

    const mtimeAfter = statSync(EMBEDDED_ASSETS).mtimeMs;
    expect(mtimeAfter).toBeGreaterThan(mtimeBefore);
  });

  test("server serves dashboard HTML after predev runs from clean state", async () => {
    // Ensure clean state.
    expect(existsSync(join(DASHBOARD_DIST, "index.html"))).toBe(false);
    expect(existsSync(EMBEDDED_ASSETS)).toBe(false);

    // Run predev.
    const predevProc = Bun.spawn(["bun", "run", "predev"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    await predevProc.exited;

    // Spawn the proxy (uses bun src/cli.ts directly, bypassing predev).
    proxy = await startProxy({
      WARMER_ENABLED: "false",
      USAGE_REFRESH_MS: "999999",
    });

    try {
      const res = await fetch(`${proxy.baseUrl}/dashboard/`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");

      const body = await res.text();
      expect(body).toContain("<!doctype html>");
      expect(body).not.toContain("dashboard not built");
    } finally {
      await proxy.kill();
    }
  });

  test("embedded-assets.ts import paths resolve to real files in dashboard/dist/", async () => {
    expect(existsSync(join(DASHBOARD_DIST, "index.html"))).toBe(false);
    expect(existsSync(EMBEDDED_ASSETS)).toBe(false);

    const proc = Bun.spawn(["bun", "run", "predev"], {
      cwd: ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;

    const content = readFileSync(EMBEDDED_ASSETS, "utf-8");
    const importRegex = /import\s+"[^"]*dashboard\/dist\/(.+?)"\s+with\s+\{\s*type:\s*"file"\s*\}/g;
    const matches = [...content.matchAll(importRegex)];
    expect(matches.length).toBeGreaterThan(0);

    const distFiles = readdirSync(DASHBOARD_DIST, { recursive: true }) as string[];
    for (const match of matches) {
      const relativePath = match[1];
      expect(distFiles).toContain(relativePath);
    }
  });
});
