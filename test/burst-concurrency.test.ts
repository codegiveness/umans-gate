import { expect, test } from "bun:test";
import { runBurst } from "./helpers/burst-harness.ts";
import { startCombinedMock } from "./helpers/combined-mock.ts";
import { startProxy } from "./helpers/proxy.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll the proxy's /dashboard/api/gate until effectiveLimit reaches the
 *  expected value (or timeout). Eliminates startup races where the proxy
 *  begins serving before the first /v1/usage fetch applies the real limit. */
async function waitForEffectiveLimit(
  proxyBaseUrl: string,
  expected: number,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${proxyBaseUrl}/dashboard/api/gate`);
      if (res.ok) {
        const stats = (await res.json()) as { effectiveLimit?: number };
        if (stats.effectiveLimit === expected) return;
      }
    } catch {
      // proxy not ready yet
    }
    await sleep(50);
  }
  throw new Error(`effectiveLimit did not reach ${expected} within ${timeoutMs}ms`);
}

test("S2 burst-no-overflow: mixed main+vision requests never exceed usage limit=4", async () => {
  const mock = startCombinedMock({ limit: 4, hardCap: 4, delayMs: 120 });
  const mockUrl = `http://127.0.0.1:${mock.port}`;
  const proxy = await startProxy({
    TARGET: mockUrl,
    umansApiKey: "test-key",
    envOverrides: {
      USAGE_REFRESH_MS: "100",
      VISION_TARGET: `${mockUrl}/v1/chat/completions`,
      VISION_STRATEGY: "always",
    },
  });

  // Wait for the first usage refresh to apply the limit.
  await waitForEffectiveLimit(proxy.baseUrl, 4);

  const result = await runBurst({
    proxyBaseUrl: proxy.baseUrl,
    targetUrl: mockUrl,
    total: 60,
    concurrency: 20,
    waves: 3,
    visionRatio: 0.5,
    sampleIntervalMs: 10,
  });

  expect(result.completed).toBe(result.sent);
  expect(mock.totalRequests).toBeGreaterThan(0);
  expect(mock.peakInFlight).toBeLessThanOrEqual(4);
  expect(result.peakInFlight).toBeLessThanOrEqual(4);
  expect(Math.max(...result.samples, 0)).toBeLessThanOrEqual(4);

  await proxy.kill();
  await mock.close();
});

test("S4 dynamic-resize-honored: after limit drops 8->3, peakInFlight stays <=3", async () => {
  const mock = startCombinedMock({ limit: 8, hardCap: 8, delayMs: 120 });
  const mockUrl = `http://127.0.0.1:${mock.port}`;
  const proxy = await startProxy({
    TARGET: mockUrl,
    umansApiKey: "test-key",
    envOverrides: {
      USAGE_REFRESH_MS: "100",
      VISION_TARGET: `${mockUrl}/v1/chat/completions`,
      VISION_STRATEGY: "always",
    },
  });
  await waitForEffectiveLimit(proxy.baseUrl, 8);

  mock.setLimit(3);
  await waitForEffectiveLimit(proxy.baseUrl, 3);

  const result = await runBurst({
    proxyBaseUrl: proxy.baseUrl,
    targetUrl: mockUrl,
    total: 40,
    concurrency: 20,
    waves: 2,
    visionRatio: 0.5,
    sampleIntervalMs: 10,
  });

  expect(result.completed).toBe(result.sent);
  expect(mock.totalRequests).toBeGreaterThan(0);
  expect(mock.peakInFlight).toBeLessThanOrEqual(3);
  expect(result.peakInFlight).toBeLessThanOrEqual(3);
  expect(Math.max(...result.samples, 0)).toBeLessThanOrEqual(3);

  await proxy.kill();
  await mock.close();
});
