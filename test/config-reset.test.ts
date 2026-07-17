// Bug C2: resetConfig() must preserve dashboard_token (alongside umans_api_key)
// and the viewer reset endpoint must call reloadConfig() so hot-reloadable
// fields take effect immediately. Restart-required fields (incl. dashboard_token)
// must NOT change in the live config until restart.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG, ensureConfigFile, resetConfig, saveConfig } from "../src/config.js";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

// ---------------------------------------------------------------------------
// Part 1 — Unit tests for resetConfig() preserving secrets on disk.
// ---------------------------------------------------------------------------

let tmpConfigDir: string;
let origXdg: string | undefined;

beforeEach(() => {
  tmpConfigDir = mkdtempSync(join(tmpdir(), "umans-gate-reset-"));
  origXdg = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = tmpConfigDir;
});

afterEach(() => {
  if (origXdg === undefined) {
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
  } else {
    process.env.XDG_CONFIG_HOME = origXdg;
  }
  rmSync(tmpConfigDir, { recursive: true, force: true });
});

describe("resetConfig preserves secrets on disk", () => {
  test("preserves umans_api_key and dashboard_token when set", () => {
    ensureConfigFile();
    saveConfig({ umans_api_key: "sk-test-key-123", dashboard_token: "tok-dashboard-456" });

    const result = resetConfig();
    expect(result.ok).toBe(true);

    const onDisk = JSON.parse(readFileSync(resolveConfigPathForTest(), "utf-8"));
    expect(onDisk.umans_api_key).toBe("sk-test-key-123");
    expect(onDisk.dashboard_token).toBe("tok-dashboard-456");
  });

  test("falls back to defaults when secrets are unset", () => {
    ensureConfigFile();
    // Defaults have empty strings for both.
    resetConfig();
    const onDisk = JSON.parse(readFileSync(resolveConfigPathForTest(), "utf-8"));
    expect(onDisk.umans_api_key).toBe(DEFAULT_CONFIG.umans_api_key);
    expect(onDisk.dashboard_token).toBe(DEFAULT_CONFIG.dashboard_token);
  });

  test("preserves only secrets; other fields reset to defaults", () => {
    ensureConfigFile();
    saveConfig({
      umans_api_key: "sk-preserved",
      dashboard_token: "tok-preserved",
      port: 8888,
      breaker_threshold: 99,
      concurrency_hard_cap: 7,
    });

    resetConfig();
    const onDisk = JSON.parse(readFileSync(resolveConfigPathForTest(), "utf-8"));
    expect(onDisk.umans_api_key).toBe("sk-preserved");
    expect(onDisk.dashboard_token).toBe("tok-preserved");
    // Non-secret fields reverted to defaults.
    expect(onDisk.port).toBe(DEFAULT_CONFIG.port);
    expect(onDisk.breaker_threshold).toBe(DEFAULT_CONFIG.breaker_threshold);
    expect(onDisk.concurrency_hard_cap).toBe(DEFAULT_CONFIG.concurrency_hard_cap);
  });
});

function resolveConfigPathForTest(): string {
  return join(tmpConfigDir, "umans-gate", "config.json");
}

// ---------------------------------------------------------------------------
// Part 2 — Integration test: reset endpoint calls reloadConfig (live effect)
// and dashboard_token (restart-required) stays unchanged in live config.
// ---------------------------------------------------------------------------

describe("reset endpoint applies reloadConfig and preserves live dashboard_token", () => {
  let proxy: ProxyHandle;
  const dashToken = "tok-integration-789";
  const authHeaders = { Authorization: `Bearer ${dashToken}` };

  beforeAll(async () => {
    proxy = await startProxy({
      dashboardToken: dashToken,
      umansApiKey: "sk-integration",
    });
  });

  afterAll(async () => {
    await proxy.kill();
  });

  test("reloadConfig fires after reset: hot-reloadable field applied live", async () => {
    // 1. Bump a hot-reloadable field (concurrency_hard_cap) to a non-default
    //    value via POST /api/config. The dashboard auto-reloads on save, so
    //    the live gate hardCap becomes 7.
    const saveRes = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ concurrency_hard_cap: 7 }),
    });
    expect(saveRes.ok).toBe(true);
    const saveJson = (await saveRes.json()) as { ok: boolean };
    expect(saveJson.ok).toBe(true);

    // The dashboard client calls reloadFromDisk after save; mirror that here
    // so the live gate reflects the saved value before we test the reset path.
    const reloadAfterSave = await fetch(`${proxy.baseUrl}/dashboard/api/config/reload`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(reloadAfterSave.ok).toBe(true);

    // Confirm the live gate reflects 7.
    const gateBefore = (await (
      await fetch(`${proxy.baseUrl}/dashboard/api/gate`, { headers: authHeaders })
    ).json()) as {
      hardCap: number;
    };
    expect(gateBefore.hardCap).toBe(7);

    // 2. Call the reset endpoint. resetConfig() writes defaults to disk
    //    (concurrency_hard_cap back to DEFAULT_CONFIG.concurrency_hard_cap=1).
    //    Without the fix: reloadConfig is NOT called, so live hardCap stays 7.
    //    With the fix:    reloadConfig IS called, so live hardCap becomes 1.
    const resetRes = await fetch(`${proxy.baseUrl}/dashboard/api/config/reset`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(resetRes.ok).toBe(true);
    const resetJson = (await resetRes.json()) as {
      ok: boolean;
      written: { has_api_key: boolean; has_dashboard_token: boolean };
    };
    expect(resetJson.ok).toBe(true);

    // 3. Verify the live gate now reflects the DEFAULT hardCap (16), proving
    //    reloadConfig was called and applied the reset value live.
    const gateAfter = (await (
      await fetch(`${proxy.baseUrl}/dashboard/api/gate`, { headers: authHeaders })
    ).json()) as {
      hardCap: number;
    };
    // DEFAULT_CONFIG.concurrency_hard_cap is 16 (src/config/defaults.ts:20).
    expect(gateAfter.hardCap).toBe(16);
  });

  test("dashboard_token (restart-required) unchanged in live config after reset", async () => {
    // After the reset above, dashboard_token was preserved on disk (Part 1
    // verifies that). Even though reloadConfig ran, dashboard_token is in
    // RESTART_REQUIRED_FIELDS so the live ProxyConfig.dashboardToken — which
    // came from the DASHBOARD_TOKEN env var at startup — must still be set.
    const cfgRes = await fetch(`${proxy.baseUrl}/dashboard/api/config`, { headers: authHeaders });
    const cfg = (await cfgRes.json()) as { has_dashboard_token: boolean; has_api_key: boolean };
    expect(cfg.has_dashboard_token).toBe(true);
    expect(cfg.has_api_key).toBe(true);
  });

  test("reset endpoint still responds 401 without dashboard token when one is set", async () => {
    // Sanity: the auth gate is unaffected by the reset/reload changes.
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/config/reset`, { method: "POST" });
    expect(res.status).toBe(401);
  });
});
