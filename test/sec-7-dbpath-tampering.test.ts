// Regression test for SEC-7: db_path validation rejects path traversal.
//
// BEFORE: POST /dashboard/api/config accepted any db_path value — only
// validation was non-empty string. Path traversal like "../../../tmp/evil"
// was accepted and persisted to config.json.
//
// AFTER: db_path validation rejects paths containing "..".
//
// CWE-22 (Path Traversal), CWE-306 (Missing Auth — mitigated by SEC-4 CSRF fix).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

let proxy: ProxyHandle;
const tmpHome = `/tmp/umans-gate-sec7-${Date.now()}`;

beforeAll(async () => {
  proxy = await startProxy({
    umansApiKey: "sk-sec7-dbpath",
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

test("SEC-7a: db_path with path traversal (..) is rejected", async () => {
  const traversalPath = "../../../tmp/umans-gate-sec7-traversal-test.db";
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ db_path: traversalPath }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.ok).toBe(false);
  expect(body.errors.join(" ")).toContain("traversal");
});

test("SEC-7b: normal db_path is accepted", async () => {
  const safePath = "/tmp/umans-gate-sec7-safe-test.db";
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ db_path: safePath }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
  expect(body.written?.db_path).toBe(safePath);
});

test("SEC-7c: empty db_path is rejected", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ db_path: "" }),
  });
  expect(res.status).toBe(400);
  const body = await res.json();
  expect(body.ok).toBe(false);
});
