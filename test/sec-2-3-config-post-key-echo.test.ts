// Regression test for SEC-2/3: POST /dashboard/api/config and /config/reset
// must NOT echo umans_api_key in the `written` field of the JSON response.
//
// BEFORE: POST /config returned `saveConfig()` result whose `written.umans_api_key`
// contained the actual key value in plaintext. POST /config/reset had the same leak.
//
// AFTER: Both POST handlers strip umans_api_key from `written`, replacing it
// with a `has_api_key: boolean` — mirroring the SEC-1 fix for GET /config.
//
// CWE-200 (Exposure of Sensitive Information).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

const SECRET = "sk-sec23-secret-do-not-leak-via-post";
const tmpHome = `/tmp/umans-gate-sec23-${Date.now()}`;

let proxy: ProxyHandle;

beforeAll(async () => {
  const configDir = join(tmpHome, ".config", "umans-gate");
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.json"), JSON.stringify({ umans_api_key: SECRET }), "utf-8");

  proxy = await startProxy({
    umansApiKey: SECRET,
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    envOverrides: { XDG_CONFIG_HOME: `${tmpHome}/.config` },
  });
});

afterAll(async () => {
  await proxy.kill();
  try {
    rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

test("SEC-2: POST /dashboard/api/config does not echo umans_api_key in written", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.written?.umans_api_key).toBeUndefined();
  expect(body.written?.has_api_key).toBe(true);
  const bodyText = JSON.stringify(body);
  expect(bodyText).not.toContain(SECRET);
});

test("SEC-3: POST /dashboard/api/config/reset does not echo umans_api_key in written", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config/reset`, {
    method: "POST",
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.written?.umans_api_key).toBeUndefined();
  expect(body.written?.has_api_key).toBe(true);
  const bodyText = JSON.stringify(body);
  expect(bodyText).not.toContain(SECRET);
});
