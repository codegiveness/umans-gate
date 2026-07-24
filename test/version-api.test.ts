// Ticket 01: Version display + update availability check.
// Integration tests for GET /dashboard/api/version and
// POST /dashboard/api/version/check.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pkg from "../package.json" with { type: "json" };
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  lastCheckedAt: number | null;
  error: string | null;
  releaseNotes: string | null;
  canUpdate: boolean;
  canUpdateReason: string | null;
}

describe("version API — without dashboard token", () => {
  let proxy: ProxyHandle;

  beforeAll(async () => {
    proxy = await startProxy({ umansApiKey: "sk-test" });
  });

  afterAll(async () => {
    await proxy.kill();
  });

  test("GET /dashboard/api/version returns correct shape", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/version`);
    expect(res.ok).toBe(true);
    const data = (await res.json()) as VersionInfo;
    expect(data.current).toBe(pkg.version);
    expect(typeof data.updateAvailable).toBe("boolean");
    expect(typeof data.canUpdate).toBe("boolean");
    expect(data.canUpdateReason === null || typeof data.canUpdateReason === "string").toBe(true);
    expect(data.releaseNotes).toBeNull();
  });

  test("POST /dashboard/api/version/check returns data with lastCheckedAt", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/version/check`, { method: "POST" });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as VersionInfo;
    expect(data.current).toBe(pkg.version);
    expect(data.lastCheckedAt).not.toBeNull();
    expect(typeof data.lastCheckedAt).toBe("number");
  });

  test("canUpdate is false and canUpdateReason is no_token without dashboard token", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/version/check`, { method: "POST" });
    const data = (await res.json()) as VersionInfo;
    expect(data.canUpdate).toBe(false);
    expect(data.canUpdateReason).toBe("no_token");
  });
});

describe("version API — with dashboard token", () => {
  let proxy: ProxyHandle;
  const dashToken = "tok-version-test-001";
  const authHeaders = { Authorization: `Bearer ${dashToken}` };

  beforeAll(async () => {
    proxy = await startProxy({
      dashboardToken: dashToken,
      umansApiKey: "sk-test",
    });
  });

  afterAll(async () => {
    await proxy.kill();
  });

  test("GET /dashboard/api/version requires auth", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/version`);
    expect(res.status).toBe(401);
  });

  test("GET /dashboard/api/version returns shape with auth", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/version`, { headers: authHeaders });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as VersionInfo;
    expect(data.current).toBe(pkg.version);
    expect(typeof data.updateAvailable).toBe("boolean");
    expect(data.releaseNotes).toBeNull();
  });

  test("POST /dashboard/api/version/check with token: canUpdate reflects service state", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/version/check`, {
      method: "POST",
      headers: authHeaders,
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as VersionInfo;
    expect(data.lastCheckedAt).not.toBeNull();
    // Service may or may not be installed on the test machine; verify the contract.
    if (data.canUpdate) {
      expect(data.canUpdateReason).toBeNull();
    } else {
      expect(data.canUpdateReason).toBe("no_service");
    }
  });

  test("releaseNotes is null when updateAvailable is false", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/version`, { headers: authHeaders });
    const data = (await res.json()) as VersionInfo;
    expect(data.updateAvailable).toBe(false);
    expect(data.releaseNotes).toBeNull();
  });
});
