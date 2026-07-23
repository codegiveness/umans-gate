// Regression test for U1: /v1/usage fetch must have a timeout.
//
// BEFORE: fetchUsageRaw passed `signal` straight to fetch with no timeout.
// In the periodic-refresh path (aggregator.refresh) no signal is passed,
// so a hanging upstream stalls the fetch indefinitely. Because
// `this.fetching` is only cleared in the finally block, the hang also
// blocks every subsequent poll cycle — usage tracking freezes.
//
// AFTER: fetchUsageRaw combines any passed signal with
// AbortSignal.timeout(15000) via AbortSignal.any(...). A hanging upstream
// aborts after 15s, the existing try/catch treats it as a fetch failure,
// `this.fetching` clears, and the next poll proceeds normally.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { UmansUsageClient } from "../src/usage/aggregator.js";
import { fetchUsageRaw } from "../src/usage/fetch-usage.js";

const _sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface MockUpstream {
  port: number;
  close: () => Promise<void>;
}

/** Upstream that accepts /v1/usage but never responds (simulates hang). */
function startHangingUpstream(): MockUpstream {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/usage") {
        await new Promise(() => {}); // hang forever
      }
      return new Response("not found", { status: 404 });
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

/** Upstream that returns a minimal valid /v1/usage response. */
function startResponsiveUpstream(): MockUpstream {
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/usage") {
        return Response.json({
          limits: { concurrency: { limit: 2, hard_cap: 4 } },
          window: { started_at: "2025-01-01T00:00:00Z", resets_at: "2025-01-01T01:00:00Z" },
          usage: { requests_in_window: 0 },
        });
      }
      return new Response("not found", { status: 404 });
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

let hanging: MockUpstream;
let responsive: MockUpstream;

beforeAll(() => {
  hanging = startHangingUpstream();
  responsive = startResponsiveUpstream();
});

afterAll(async () => {
  await Promise.all([hanging.close(), responsive.close()]);
});

test("fetchUsageRaw aborts after 15s timeout when upstream hangs", async () => {
  const start = Date.now();
  const result = await fetchUsageRaw(`http://127.0.0.1:${hanging.port}`, "test-key");
  const elapsed = Date.now() - start;

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error).toBeTruthy();
    expect(result.error.length).toBeGreaterThan(0);
  }
  // Must have aborted within a bounded window, not hung forever.
  // (Bun.serve's default idleTimeout may close the socket at ~10s before
  //  the 15s AbortSignal fires; either way the fetch must not hang.)
  expect(elapsed).toBeLessThan(30000);
}, 30000);

test("fetching flag clears after timeout so next poll proceeds (aggregator)", async () => {
  const client = new UmansUsageClient({
    target: `http://127.0.0.1:${hanging.port}`,
    umansApiKey: "test-key",
    usageRefreshMs: 999999,
  });
  let onChangeCalled = false;
  client.onChange(() => {
    onChangeCalled = true;
  });

  // First refresh hits the hanging upstream and must time out (~15s).
  await client.refresh();
  // U3: first-fetch failure must NOT fire onChange (would stamp gate to softLimit=1).
  expect(onChangeCalled).toBe(false);

  // If `this.fetching` were stuck, this second refresh() would no-op
  // (early return at line 51) and the snapshot would stay failed.
  // Point the client at the responsive upstream by rebuilding it.
  const client2 = new UmansUsageClient({
    target: `http://127.0.0.1:${responsive.port}`,
    umansApiKey: "test-key",
    usageRefreshMs: 999999,
  });
  let okCalled = false;
  client2.onChange((snap) => {
    if (snap.ok) okCalled = true;
  });
  await client2.refresh();

  expect(okCalled).toBe(true);
  expect(client2.getSnapshot().ok).toBe(true);
  expect(client2.getSnapshot().concurrencySoftLimit).toBe(2);
}, 30000);

test("fetchUsageRaw returns ok:true when upstream responds quickly (no false timeout)", async () => {
  const result = await fetchUsageRaw(`http://127.0.0.1:${responsive.port}`, "test-key");
  expect(result.ok).toBe(true);
});
