// Regression test for SEC-4: Dashboard POST endpoints reject cross-origin requests.
//
// BEFORE: No Origin/Referer validation. A malicious website could send POST
// requests to the local dashboard API (CSRF). text/plain Content-Type bypassed
// CORS preflight and was parsed as JSON by Bun's req.json().
//
// AFTER: The request dispatcher validates Origin (and Referer fallback) on all
// POST/DELETE requests to /dashboard/*. Foreign origins receive 403.
//
// CWE-352 (CSRF).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

let proxy: ProxyHandle;

beforeAll(async () => {
  proxy = await startProxy({
    umansApiKey: "sk-csrf-test",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
  });
});

afterAll(async () => {
  await proxy.kill();
});

test("SEC-4a: POST with foreign Origin is rejected (403)", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: "https://evil.attacker.com",
    },
    body: JSON.stringify({ max_captures: 42 }),
  });
  expect(res.status).toBe(403);
});

test("SEC-4b: POST with foreign Referer (no Origin) is rejected (403)", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: "https://evil.attacker.com/exploit.html",
    },
    body: JSON.stringify({ max_captures: 99 }),
  });
  expect(res.status).toBe(403);
});

test("SEC-4c: POST with local Origin is accepted", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: `http://127.0.0.1:${proxy.port}`,
    },
    body: JSON.stringify({ max_captures: 200 }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.ok).toBe(true);
});

test("SEC-4d: POST without Origin/Referer (non-browser client) is accepted", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rate_limit_requests: -1 }),
  });
  expect(res.status).toBe(200);
});

test("SEC-4e: POST with malformed Referer (no Origin) is rejected, not 500", async () => {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/config`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Referer: "not-a-valid-url",
    },
    body: JSON.stringify({ max_captures: 1 }),
  });
  expect(res.status).toBe(403);
});
