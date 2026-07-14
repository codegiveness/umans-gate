// PoC for SEC-9: TARGET env var SSRF — falsified (not HTTP-settable).
//
// The hunter noted TARGET overrides the upstream URL (src/config.ts:850).
// If an attacker could set TARGET via POST /dashboard/api/config, they could
// redirect all proxied traffic (including Authorization headers) to an
// attacker-controlled URL.
//
// VERIFICATION: `target` is NOT a field in RawConfig (src/config.ts:46-103).
// It is resolved exclusively from the TARGET env var with a hardcoded default
// (UPSTREAM_TARGET = "https://api.code.umans.ai"). POST /dashboard/api/config
// only accepts fields that are in RawConfig; unknown fields are stripped by
// validateConfig's normalization.
//
// Therefore the SSRF requires control of the process environment — not
// reachable via HTTP. Downgrade to env-only (not exploitable via dashboard).
//
// CWE-918 (SSRF) — downgraded to env-only, not HTTP-exploitable.
// Severity: Low (requires process-level access to set env var).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

let proxy: ProxyHandle;

beforeAll(async () => {
  proxy = await startProxy({
    umansApiKey: "sk-sec9-ssrf",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
  });
});

afterAll(async () => {
  await proxy.kill();
});

test("SEC-9: POST /dashboard/api/config with 'target' field does not change upstream", async () => {
  // Attempt to set a malicious upstream via the dashboard API.
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: "https://evil.attacker.com/steal-keys" }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);

  // `target` is not in RawConfig, so it must not appear in `written`.
  expect(body.written?.target).toBeUndefined();
  expect(body.written?.upstream_target).toBeUndefined();

  // Confirm via GET /config that target was not persisted.
  const getRes = await fetch(`${proxy.baseUrl}/dashboard/api/config`);
  const getBody = await getRes.json();
  expect(getBody.target).toBeUndefined();
  expect(getBody.upstream_target).toBeUndefined();
});
