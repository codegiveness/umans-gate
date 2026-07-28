// Regression test for C1: Upstream hang must not hold permit indefinitely.
//
// BEFORE: `signal: req.signal` — only the client's abort signal.
// If upstream hangs and client stays connected, the permit is held forever.
//
// AFTER: `AbortSignal.any([req.signal, AbortSignal.timeout(config.upstreamTimeoutMs)])`
// — 5 minute default timeout. If upstream hangs, proxy returns 504 and releases permit.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "../helpers/proxy.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Upstream that accepts the connection but never responds (simulates hang). */
function startHangingUpstream(): { port: number; close: () => Promise<void> } {
  const server = Bun.serve({
    port: 0,
    websocket: {
      open() {},
      message() {},
      close() {},
    },
    async fetch() {
      // Never return a response — simulate upstream hang
      await new Promise(() => {}); // hangs forever
    },
  });
  return {
    port: server.port!,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

let proxy: ProxyHandle;
let upstream: { port: number; close: () => Promise<void> };

beforeAll(async () => {
  upstream = startHangingUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${upstream.port}`,
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    STAMP_CACHE_TTL_ENABLED: "false",
    CONCURRENCY_HARD_CAP: "1",
    CONCURRENCY_SOFT_LIMIT: "1",
    RELEASE_COOLDOWN_MS: "0",
    UPSTREAM_TIMEOUT_MS: "500", // 500ms timeout for fast test
  });
});

afterAll(async () => {
  await proxy.kill();
  upstream.close();
});

test("upstream hang returns 504 Gateway Timeout, not 502", async () => {
  const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      max_tokens: 10,
      stream: true,
      messages: [{ role: "user", content: "test" }],
    }),
  });

  expect(res.status).toBe(504);
  const body = await res.text();
  expect(body).toContain("Gateway Timeout");
});

test("permit is released after upstream timeout — next request succeeds immediately", async () => {
  // First request: will time out (500ms)
  const r1 = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      max_tokens: 10,
      stream: true,
      messages: [{ role: "user", content: "first" }],
    }),
  });
  expect(r1.status).toBe(504);
  await r1.text();

  await sleep(100);

  // Second request: if permit leaked, this would block forever (hard cap = 1)
  // With the fix, permit was released after 504, so this should proceed
  const start = Date.now();
  const r2 = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      max_tokens: 10,
      stream: true,
      messages: [{ role: "user", content: "second" }],
    }),
  });
  const elapsed = Date.now() - start;

  // Should get 504 again (upstream still hanging), but critically, it should
  // not hang waiting for a permit — it should proceed immediately
  expect(r2.status).toBe(504);
  expect(elapsed).toBeLessThan(2000); // well within the 500ms timeout + overhead
  await r2.text();
});
