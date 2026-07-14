// Documented behavior for SEC-5: Local capture data access via GET /dashboard/api/captures.
//
// The dashboard API is bound to 127.0.0.1 and accepts unauthenticated GET
// requests. This is inherent to a local dev tool (like webpack-dev-server).
// The CSRF fix (SEC-4) prevents remote exploitation via cross-origin POSTs.
// Local process access remains by design — users who need isolation should
// use SSH tunneling or a firewall.
//
// CWE-306 (Missing Authentication for Critical Function), CWE-200.
// Severity: Low (local-only; remote vector closed by SEC-4 CSRF fix).

import { afterAll, beforeAll, expect, test } from "bun:test";
import { startCombinedMock } from "./helpers/combined-mock.ts";
import { type ProxyHandle, startProxy } from "./helpers/proxy.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let proxy: ProxyHandle;
let mock: ReturnType<typeof startCombinedMock>;

beforeAll(async () => {
  mock = startCombinedMock({ limit: 1, hardCap: 1, delayMs: 10 });
  const mockUrl = `http://127.0.0.1:${mock.port}`;
  proxy = await startProxy({
    TARGET: mockUrl,
    umansApiKey: "sk-sec5-exfil-test",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
  });
});

afterAll(async () => {
  await proxy.kill();
  mock.close();
});

test("SEC-5a: GET /dashboard/api/captures returns capture list without auth", async () => {
  // Send a toy request through the proxy so there's at least one capture.
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": "toy-client-key",
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5",
      max_tokens: 16,
      messages: [{ role: "user", content: "secret prompt: the eagle lands at midnight" }],
    }),
  });
  await sleep(300); // let the capture flush

  const res = await fetch(`${proxy.baseUrl}/dashboard/api/captures`);
  expect(res.status).toBe(200);
  const rows = (await res.json()) as unknown[];
  expect(rows.length).toBeGreaterThan(0);
});

test("SEC-5b: GET /dashboard/api/captures/:id returns full request/response bodies without auth", async () => {
  const list = await (await fetch(`${proxy.baseUrl}/dashboard/api/captures`)).json();
  const rows = list as Array<{ id: number }>;
  expect(rows.length).toBeGreaterThan(0);
  const id = rows[0].id;

  const res = await fetch(`${proxy.baseUrl}/dashboard/api/captures/${id}`);
  expect(res.status).toBe(200);
  const bodyText = await res.text();
  // The secret prompt sent through the proxy is readable without auth.
  expect(bodyText).toContain("the eagle lands at midnight");
});
