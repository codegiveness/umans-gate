// Regression test for U7: Clear priorityLow on fetch failure.
//
// BEFORE: applyFailedSnapshot spread the previous snapshot with only
// `ok: false` and `fetchedAt: Date.now()`. This carried forward
// `priorityLow: true` indefinitely across every subsequent fetch failure.
// In src/index.ts:328 the onChange callback applies a -1 penalty:
//   `if (snap.priorityLow) effective = Math.max(1, effective - 1)`.
// So once the upstream demoted priority and then went unreachable, the
// effective concurrency limit stayed reduced forever (even after the
// upstream recovered enough to serve a failure response).
//
// AFTER: applyFailedSnapshot also sets `priorityLow: false` in the
// spread. We can't confirm demotion status when the upstream is
// unreachable, so clearing the -1 penalty is less harmful than keeping
// it stuck on.
//
// Uses fetch mocking (not real Bun.serve upstreams) so the SAME client
// instance can be driven through demoted → fail → normal in one test
// without swapping ports. The bug only manifests on the `if (this.snapshot)`
// branch of applyFailedSnapshot (prior snapshot exists), so each test
// first seeds a successful snapshot before triggering the failure path.

import { expect, test } from "bun:test";
import type { UsageSnapshot } from "../../src/types.js";
import { UmansUsageClient } from "../../src/usage/aggregator.js";

/** A minimal raw usage response with the given priority.low value. */
function rawUsage(low: boolean) {
  return {
    plan: { display_name: "Code Pro" },
    limits: { concurrency: { limit: 4, hard_cap: 8, burst_pct: 0 } },
    usage: {
      requests_in_window: 0,
      concurrent_sessions: 0,
      priority: { low, boxed_until: null, reason: null },
      service_mode: { current: "normal", resets_at: null },
    },
  };
}

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeFetchMock(handlers: Array<() => Response>): typeof fetch {
  let i = 0;
  return (() => {
    const handler = handlers[Math.min(i, handlers.length - 1)];
    i++;
    return Promise.resolve(handler());
  }) as unknown as typeof fetch;
}

test("(fetch-mock) demoted then fail → priorityLow cleared on failure", async () => {
  const originalFetch = globalThis.fetch;
  // 1st call: demoted (priorityLow: true). 2nd+ calls: 500 failure.
  globalThis.fetch = makeFetchMock([
    () => jsonOk(rawUsage(true)),
    () => new Response("err", { status: 500 }),
    () => new Response("err", { status: 500 }),
  ]);
  try {
    const client = new UmansUsageClient({
      target: "https://example.test",
      umansApiKey: "test-key",
      usageRefreshMs: 999999,
    });
    const snaps: UsageSnapshot[] = [];
    client.onChange((s) => {
      snaps.push(s);
    });

    // 1) Successful demoted fetch → priorityLow: true
    await client.refresh();
    expect(snaps.length).toBe(1);
    expect(snaps[0].ok).toBe(true);
    expect(snaps[0].priorityLow).toBe(true);

    // 2) Next fetch fails → priorityLow must be cleared (false), not carried.
    await client.refresh();
    expect(snaps.length).toBe(2);
    expect(snaps[1].ok).toBe(false);
    // The bug: priorityLow stays true. The fix: priorityLow becomes false.
    expect(snaps[1].priorityLow).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("(fetch-mock) demoted → fail → succeed normal → priorityLow stays false", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock([
    () => jsonOk(rawUsage(true)), // demoted
    () => new Response("err", { status: 500 }), // failure
    () => jsonOk(rawUsage(false)), // normal recovery
    () => jsonOk(rawUsage(false)),
  ]);
  try {
    const client = new UmansUsageClient({
      target: "https://example.test",
      umansApiKey: "test-key",
      usageRefreshMs: 999999,
    });
    const snaps: UsageSnapshot[] = [];
    client.onChange((s) => {
      snaps.push(s);
    });

    // 1) Demoted: priorityLow true
    await client.refresh();
    expect(snaps[0].priorityLow).toBe(true);

    // 2) Failure: priorityLow cleared
    await client.refresh();
    expect(snaps[1].ok).toBe(false);
    expect(snaps[1].priorityLow).toBe(false);

    // 3) Recovery with priorityLow false → normal behavior
    await client.refresh();
    expect(snaps[2].ok).toBe(true);
    expect(snaps[2].priorityLow).toBe(false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
