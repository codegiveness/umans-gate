// Ticket 01: Version display + update availability check.
// Integration tests for GET /dashboard/api/version and
// POST /dashboard/api/version/check.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import pkg from "../../package.json" with { type: "json" };
import { isServiceInstalled } from "../../src/service/index.js";
import { type ProxyHandle, startProxy } from "../helpers/proxy.js";

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

  test("canUpdate reflects service state without dashboard token", async () => {
    const res = await fetch(`${proxy.baseUrl}/dashboard/api/version/check`, { method: "POST" });
    const data = (await res.json()) as VersionInfo;
    // Token no longer gates update; only service-manager check applies.
    const serviceInstalled = await isServiceInstalled();
    if (serviceInstalled) {
      expect(data.canUpdate).toBe(true);
      expect(data.canUpdateReason).toBeNull();
    } else {
      expect(data.canUpdate).toBe(false);
      expect(data.canUpdateReason).toBe("no_service");
    }
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

describe("update API — POST /dashboard/api/update", () => {
  describe("without dashboard token", () => {
    let proxy: ProxyHandle;

    beforeAll(async () => {
      proxy = await startProxy({ umansApiKey: "sk-test" });
    });

    afterAll(async () => {
      await proxy.kill();
    });

    test("returns not_service_managed when no service installed (token no longer required)", async () => {
      const serviceInstalled = await isServiceInstalled();
      const res = await fetch(`${proxy.baseUrl}/dashboard/api/update`, { method: "POST" });
      const data = (await res.json()) as { ok: boolean; error?: string; targetVersion?: string };
      if (serviceInstalled) {
        // Service installed but no update is available in the test env.
        expect(data.ok).toBe(false);
        expect(data.error === "already_up_to_date").toBe(true);
      } else {
        expect(res.status).toBe(400);
        expect(data.ok).toBe(false);
        expect(data.error).toBe("not_service_managed");
      }
    });
  });

  describe("with dashboard token", () => {
    let proxy: ProxyHandle;
    const dashToken = "tok-update-test-002";
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

    test("requires auth when token is set", async () => {
      const res = await fetch(`${proxy.baseUrl}/dashboard/api/update`, { method: "POST" });
      expect(res.status).toBe(401);
    });

    test("returns 400 not_service_managed when token set but no service installed", async () => {
      const serviceInstalled = await isServiceInstalled();
      const res = await fetch(`${proxy.baseUrl}/dashboard/api/update`, {
        method: "POST",
        headers: authHeaders,
      });
      expect(res.status).toBe(400);
      const data = (await res.json()) as { ok: boolean; error: string };
      expect(data.ok).toBe(false);
      if (serviceInstalled) {
        expect(data.error).toBe("already_up_to_date");
      } else {
        expect(data.error).toBe("not_service_managed");
      }
    });

    test("returns already_up_to_date when no update is available", async () => {
      // Populate the cache by running a version check first.
      await fetch(`${proxy.baseUrl}/dashboard/api/version/check`, {
        method: "POST",
        headers: authHeaders,
      });
      const res = await fetch(`${proxy.baseUrl}/dashboard/api/update`, {
        method: "POST",
        headers: authHeaders,
      });
      const data = (await res.json()) as { ok: boolean; error?: string; targetVersion?: string };
      if (data.ok) {
        // An update is available and service is installed (unusual in CI).
        // Do not trigger the actual update — only assert the contract shape.
        expect(typeof data.targetVersion).toBe("string");
      } else {
        expect(data.error === "not_service_managed" || data.error === "already_up_to_date").toBe(
          true,
        );
      }
    });
  });
});
