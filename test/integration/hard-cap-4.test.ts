import { expect, test } from "bun:test";
import { runBurst } from "../helpers/burst-harness.ts";
import { startCombinedMock } from "../helpers/combined-mock.ts";
import { startProxy } from "../helpers/proxy.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

test("hard-cap-4: gate never exceeds 4 concurrent requests under burst load", async () => {
  const mock = startCombinedMock({ limit: 4, hardCap: 4, delayMs: 120 });
  const mockUrl = `http://127.0.0.1:${mock.port}`;
  const proxy = await startProxy({
    TARGET: mockUrl,
    umansApiKey: "test-key",
    envOverrides: {
      CONCURRENCY_HARD_CAP: "4",
      USAGE_REFRESH_MS: "100",
      VISION_TARGET: `${mockUrl}/v1/chat/completions`,
      VISION_STRATEGY: "always",
    },
  });

  await sleep(400);

  const result = await runBurst({
    proxyBaseUrl: proxy.baseUrl,
    targetUrl: mockUrl,
    total: 80,
    concurrency: 30,
    waves: 4,
    visionRatio: 0.5,
    sampleIntervalMs: 10,
  });

  expect(result.completed).toBe(result.sent);
  expect(mock.totalRequests).toBeGreaterThan(0);
  expect(mock.peakInFlight).toBeLessThanOrEqual(4);
  expect(result.peakInFlight).toBeLessThanOrEqual(4);
  expect(Math.max(...result.samples, 0)).toBeLessThanOrEqual(4);

  const finalStats = result.gateStatsSamples.at(-1);
  if (!finalStats) throw new Error("no gate stats samples collected");
  expect(finalStats.softLimit).toBe(4);
  expect(finalStats.hardCap).toBe(4);

  await proxy.kill();
  await mock.close();
}, 30_000);
