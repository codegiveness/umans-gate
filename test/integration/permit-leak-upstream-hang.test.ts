// Regression test: when the upstream sends chunk1 then hangs (no further data),
// and the proxy's upstream timeout (AbortSignal.timeout) fires AFTER the Response
// has already been returned to Bun.serve, the concurrency permit must still be
// released.
//
// Before the fix, only req.signal was listened to for abort, and the upstream
// timeout signal was ignored — so the permit leaked permanently. The fix adds
// a listener on the upstream signal (Part A) plus a per-request watchdog timer
// (Part C) as a safety net.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "../helpers/proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let upstream: ReturnType<typeof Bun.serve>;
let proxy: ProxyHandle;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch() {
      return new Response(
        new ReadableStream({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode("data: chunk1\n\n"));
            // Never send another chunk — simulates upstream hang after first byte.
            await sleep(30_000);
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        },
      );
    },
  });

  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${upstream.port}`,
    WARMER_ENABLED: "false",
    RELEASE_COOLDOWN_MS: "0",
    CONCURRENCY_HARD_CAP: "2",
    CONCURRENCY_SOFT_LIMIT: "2",
    // Short upstream timeout so the test doesn't take 5 minutes.
    // The watchdog fires at upstream_timeout_ms + 5s grace.
    UPSTREAM_TIMEOUT_MS: "1000",
    // Disable TTFT watchdog (default-on since 0.6.0) — this test isolates
    // the permit-release-on-upstream-hang path, not TTFT retry behavior.
    EXPERIMENT_TTFT_WATCHDOG: "false",
  });
});

afterAll(async () => {
  await proxy.kill();
  upstream.stop();
});

async function getGateActive(): Promise<number> {
  const res = await fetch(`${proxy.baseUrl}/dashboard/api/gate`);
  const stats = (await res.json()) as { active: number };
  return stats.active;
}

describe("permit release on upstream hang after return", () => {
  test("permit is released when upstream hangs after chunk1", async () => {
    // We do NOT abort the client — the client stays connected. The upstream
    // hangs, and the upstream timeout signal fires. This is the exact bug
    // scenario from capture 998.
    const req = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
    });

    // Wait for the first chunk to arrive (streaming started, permit is held).
    await sleep(200);
    const activeDuring = await getGateActive();
    expect(activeDuring).toBe(1);

    // Upstream hangs. The upstream timeout (1s) fires at ~1s.
    // The onAbort listener (Part A) fires on upstreamSignal abort → releasePermit().
    // The watchdog (Part C) would fire at 1s + 5s = 6s as a safety net.
    // We wait long enough for Part A to fire but not so long that the watchdog
    // also fires (to verify the primary path works, not just the safety net).
    await sleep(1_500);

    const activeAfterTimeout = await getGateActive();
    expect(activeAfterTimeout).toBe(0);

    // Clean up the still-pending request.
    try {
      const res = await req;
      // Drain or cancel the body to avoid leaking the connection.
      await res.body?.cancel();
    } catch {
      // Expected — stream may error due to upstream timeout.
    }
  });
});
