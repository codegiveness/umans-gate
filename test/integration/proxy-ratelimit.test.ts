// Integration test: handleProxy rate-limit rejection path.
// Runs the proxy in-process and asserts the sliding-window 429 behavior.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ProxyConfig } from "../../src/types.js";
import { type CombinedMockHandle, startCombinedMock } from "../helpers/combined-mock";
import { type InProcessProxyHandle, startInProcessProxy } from "../helpers/in-process-proxy";
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
      neverLimitRequests: false,
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

  test("third request returns 503 with expected body and headers", async () => {
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

    expect(res.status).toBe(503);

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

// Phase 6 upstream-snapshot rate gate. Uses the combined mock so /v1/usage can
// report unweighted requests-in-window + request caps. Asserts the snapshot gate
// blocks/passes independently of the local weighted limiter.
describe("upstream snapshot rate gate", () => {
  const REQ = {
    model: "umans-flash",
    max_tokens: 10,
    messages: [{ role: "user", content: "hello" }],
  };

  const postCompletion = (baseUrl: string) =>
    fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(REQ),
    });

  const postMessages = (baseUrl: string) =>
    fetch(`${baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(REQ),
    });

  // Fresh proxy+mock per scenario so snapshots/config never leak across tests.
  const withProxy = async (
    configOverrides: Partial<Omit<ProxyConfig, "host">>,
    fn: (u: CombinedMockHandle, p: InProcessProxyHandle) => Promise<void>,
  ) => {
    const u = startCombinedMock({ limit: 4, hardCap: 8 });
    const p = await startInProcessProxy({
      target: `http://127.0.0.1:${u.port}`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      releaseCooldownMs: 0,
      usageRefreshMs: 100,
      configOverrides,
    });
    try {
      await fn(u, p);
    } finally {
      await p.kill();
      await u.close();
    }
  };

  test("snapshot gate blocks at hardCap - margin (950 >= 1000-50)", async () => {
    await withProxy({}, async (u, p) => {
      u.setUsage({ requestsInWindow: 950, requestsHardCap: 1000, requestsLimit: 500 });
      await p.usage.refresh();
      const res = await postMessages(p.baseUrl);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string; retry_after: number };
      expect(body.error).toBe("rate_limit_exceeded");
      expect(typeof body.retry_after).toBe("number");
      expect(res.headers.get("retry-after")).not.toBeNull();
      // Upstream must NOT receive the request.
      expect(u.totalRequests).toBe(0);
    });
  });

  test("passes below hardCap - margin (949 < 1000-50)", async () => {
    await withProxy({}, async (u, p) => {
      u.setUsage({ requestsInWindow: 949, requestsHardCap: 1000, requestsLimit: 500 });
      await p.usage.refresh();
      const res = await postCompletion(p.baseUrl);
      expect(res.status).toBe(200);
      expect(u.totalRequests).toBe(1);
    });
  });

  test("snapshot gate active even when never_limit_requests true", async () => {
    await withProxy({ neverLimitRequests: true }, async (u, p) => {
      u.setUsage({ requestsInWindow: 950, requestsHardCap: 1000, requestsLimit: 500 });
      await p.usage.refresh();
      const res = await postMessages(p.baseUrl);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("rate_limit_exceeded");
      expect(u.totalRequests).toBe(0);
    });
  });

  test("snapshot gate stays active even when rate_limit_requests=-1 (unlimited local limiter must not bypass upstream safety)", async () => {
    await withProxy({ rateLimitRequests: -1 }, async (u, p) => {
      u.setUsage({ requestsInWindow: 950, requestsHardCap: 1000, requestsLimit: 500 });
      await p.usage.refresh();
      const res = await postMessages(p.baseUrl);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("rate_limit_exceeded");
      expect(u.totalRequests).toBe(0);
    });
  });
});
