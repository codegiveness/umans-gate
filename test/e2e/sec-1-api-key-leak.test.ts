// Regression test for SEC-1: API key must not leak via GET /dashboard/api/config.
//
// BEFORE: `{ ...raw, has_api_key: raw.umans_api_key != null }` — the spread
// included `umans_api_key` with its actual value in the JSON response.
//
// AFTER: `const { umans_api_key: _omitted, ...safe } = raw;` strips the key
// before spreading. Only the boolean `has_api_key` is exposed.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "../helpers/proxy.js";

let proxy: ProxyHandle;

beforeAll(async () => {
  proxy = await startProxy({
    umansApiKey: "sk-test-secret-key-do-not-leak",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    STAMP_CACHE_TTL_ENABLED: "false",
  });
});

afterAll(async () => {
  await proxy.kill();
});

test("GET /dashboard/api/config does not contain umans_api_key value", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`);
  expect(res.status).toBe(200);
  const body = await res.json();
  const bodyText = JSON.stringify(body);

  // has_api_key boolean must be present
  expect(body.has_api_key).toBe(true);

  // The actual API key value must NOT appear anywhere in the response
  expect(body.umans_api_key).toBeUndefined();
  expect(bodyText).not.toContain("sk-test-secret-key-do-not-leak");
});

test("GET /dashboard/api/config has_api_key is false when no key set", async () => {
  // Use isolated XDG_CONFIG_HOME so readConfigFile() returns a fresh
  // DEFAULT_CONFIG with no umans_api_key (the real config file may have one).
  const tmpHome = `/tmp/umans-gate-test-nokey-${Date.now()}`;
  const proxyNoKey = await startProxy({
    umansApiKey: "",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    STAMP_CACHE_TTL_ENABLED: "false",
    envOverrides: { XDG_CONFIG_HOME: `${tmpHome}/.config` },
  });
  try {
    const res = await fetch(`${proxyNoKey.baseUrl}/dashboard/api/config`);
    const body = await res.json();
    expect(body.has_api_key).toBe(false);
    expect(body.umans_api_key).toBeUndefined();
  } finally {
    await proxyNoKey.kill();
  }
});
