// Regression test: when a client disconnects mid-stream, the concurrency
// permit must be released. Before the fix, onAbort called flushCapture()
// but NOT releasePermit(), causing the gate's active count to get stuck.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "./helpers/proxy";

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
            await sleep(5000);
            controller.enqueue(new TextEncoder().encode("data: chunk2\n\n"));
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

describe("permit release on client abort", () => {
  test("permit is released when client aborts mid-stream", async () => {
    const controller = new AbortController();

    const req = fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        max_tokens: 100,
        stream: true,
        messages: [{ role: "user", content: "Hello" }],
      }),
      signal: controller.signal,
    });

    await sleep(200);
    const activeDuring = await getGateActive();
    expect(activeDuring).toBe(1);

    controller.abort();
    try {
      await req;
    } catch {
      // Expected — abort throws
    }

    await sleep(300);
    const activeAfter = await getGateActive();
    expect(activeAfter).toBe(0);
  });
});
