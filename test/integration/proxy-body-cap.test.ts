// Integration test: streaming response body capture is capped at captureBodyMaxBytes.
// The client stream must be complete; only the in-memory capture buffers
// (parts[], timedChunks[]) stop growing once the cap is exceeded.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startInProcessProxy } from "../helpers/in-process-proxy";

let upstream: ReturnType<typeof Bun.serve>;
let proxy: Awaited<ReturnType<typeof startInProcessProxy>>;

beforeAll(async () => {
  upstream = Bun.serve({
    port: 0,
    async fetch() {
      // Generate >1000 bytes of SSE chunks (20 chunks × ~70 bytes each).
      const chunks: string[] = [];
      for (let i = 0; i < 20; i++) {
        const padding = "x".repeat(60);
        chunks.push(`data: {"choices":[{"delta":{"content":"${padding}"}}]}\n\n`);
      }
      chunks.push("data: [DONE]\n\n");
      const body = chunks.join("");
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  });

  proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    stampClaudeCodeEnabled: false,
    warmerEnabled: false,
    releaseCooldownMs: 0,
    configOverrides: {
      captureBodyMaxBytes: 500,
    },
  });
});

afterAll(async () => {
  await proxy.kill();
  upstream.stop();
});

describe("proxy body capture cap", () => {
  test("client receives the full untruncated response", async () => {
    const expectedChunks: string[] = [];
    for (let i = 0; i < 20; i++) {
      const padding = "x".repeat(60);
      expectedChunks.push(`data: {"choices":[{"delta":{"content":"${padding}"}}]}\n\n`);
    }
    expectedChunks.push("data: [DONE]\n\n");
    const expectedBody = expectedChunks.join("");

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "test-model",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    const actualBody = await res.text();
    expect(actualBody).toBe(expectedBody);
  });

  test("stored response_body is truncated within the cap", async () => {
    await proxy.queue.flushNow();
    const list = proxy.db.list(50);
    const cap = list.find((c) => c.path === "/v1/chat/completions");
    expect(cap).toBeDefined();
    const detail = proxy.db.get(cap!.id);
    expect(detail).not.toBeNull();
    expect(detail!.response_body).not.toBeNull();

    // response_size must reflect the true upstream byte count (>1000).
    expect(detail!.response_size).toBeGreaterThan(1000);
    // response_body must be truncated within the ~500-byte cap (allow the
    // last partially-captured chunk to push slightly past).
    expect(detail!.response_body!.length).toBeLessThanOrEqual(600);
    expect(detail!.state).toBe("done");
  });
});
