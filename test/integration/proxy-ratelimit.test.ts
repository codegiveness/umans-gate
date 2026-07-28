// Integration test: handleProxy rate-limit rejection path.
// Runs the proxy in-process and asserts the sliding-window 429 behavior.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startInProcessProxy } from "../helpers/in-process-proxy";
import { startMockLlmUpstream } from "../helpers/mock-llm-upstream";

let upstream: ReturnType<typeof startMockLlmUpstream>;
let proxy: Awaited<ReturnType<typeof startInProcessProxy>>;

beforeAll(async () => {
  upstream = startMockLlmUpstream();
  proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    stampClaudeCodeEnabled: false,
    warmerEnabled: false,
    releaseCooldownMs: 0,
    configOverrides: {
      rateLimitRequests: 2,
    },
  });
  upstream.reset();
});

afterAll(async () => {
  await proxy.kill();
  await upstream.close();
});

describe("handleProxy rate-limit rejection", () => {
  test("first two requests pass through to upstream", async () => {
    const reqBody = {
      model: "umans-flash",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    };

    const res1 = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(res1.status).toBe(200);

    const res2 = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });
    expect(res2.status).toBe(200);
  });

  test("third request returns 429 with expected body and headers", async () => {
    const reqBody = {
      model: "umans-flash",
      max_tokens: 10,
      messages: [{ role: "user", content: "hello" }],
    };

    const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    expect(res.status).toBe(429);

    const body = (await res.json()) as { error: string; retry_after: number };
    expect(body.error).toBe("rate_limit_exceeded");
    expect(typeof body.retry_after).toBe("number");
    expect(Number.isFinite(body.retry_after)).toBe(true);
    expect(body.retry_after).toBeGreaterThanOrEqual(0);

    const headerRetryAfter = res.headers.get("retry-after");
    expect(headerRetryAfter).not.toBeNull();
    expect(headerRetryAfter).toBe(String(body.retry_after));
  });

  test("upstream received exactly two calls", async () => {
    expect(upstream.getCallCount()).toBe(2);
  });
});
