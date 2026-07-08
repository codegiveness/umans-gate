// Benchmark: prove that total upstream concurrency (main + vision) never
// exceeds the limit returned by https://api.code.umans.ai/v1/usage, even
// under a bursting harness.
//
// Run with:
//   UMANS_API_KEY=<key> bun benchmark/concurrency-gate/benchmark.ts
//
// Strategy:
// 1. Warm the real usage endpoint once to read the actual concurrency limit.
// 2. Run a local mock that returns the same limit on /v1/usage and tracks
//    peakInFlight on /v1/chat/completions.
// 3. Start umans-gate pointed at the mock.
// 4. Fire a mixed burst and assert peakInFlight <= realLimit.

import { startProxy } from "../../test/helpers/proxy.ts";
import { runBurst } from "../../test/helpers/burst-harness.ts";

interface RealUsage {
  limit: number;
  hardCap: number;
  plan: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchRealUsage(apiKey: string): Promise<RealUsage> {
  const res = await fetch("https://api.code.umans.ai/v1/usage", {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) {
    throw new Error(`usage endpoint returned HTTP ${res.status}`);
  }
  const json = (await res.json()) as {
    plan?: { display_name?: string };
    limits?: { concurrency?: { limit?: number; hard_cap?: number } };
  };
  const limit = json.limits?.concurrency?.limit ?? 0;
  const hardCap = json.limits?.concurrency?.hard_cap ?? limit;
  const plan = json.plan?.display_name ?? "unknown";
  if (limit <= 0) {
    throw new Error(`usage endpoint returned invalid limit: ${limit}`);
  }
  return { limit, hardCap, plan };
}

function startCombinedMock(usage: RealUsage, port?: number) {
  let inFlight = 0;
  let peakInFlight = 0;
  const samples: number[] = [];
  const server = Bun.serve({
    port: port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/usage") {
        return Response.json({
          plan: { display_name: usage.plan },
          limits: {
            concurrency: {
              limit: usage.limit,
              hard_cap: usage.hardCap,
              burst_pct: 0,
            },
          },
          usage: {
            requests_in_window: 0,
            remaining_requests: null,
            concurrent_sessions: 0,
            priority: { low: false, boxed_until: null },
          },
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (await req.json().catch(() => ({}))) as { stream?: boolean };
        const streaming = body.stream === true;
        const id = `chatcmpl-benchmark-${samples.length + 1}`;
        const enc = new TextEncoder();

        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        samples.push(inFlight);

        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await sleep(120);
              if (streaming) {
                controller.enqueue(
                  enc.encode(
                    `data: ${JSON.stringify({
                      id,
                      object: "chat.completion.chunk",
                      choices: [{ delta: { content: "ok" } }],
                    })}
\n\n`,
                  ),
                );
                controller.enqueue(enc.encode("data: [DONE]\n\n"));
              } else {
                controller.enqueue(
                  enc.encode(
                    JSON.stringify({
                      id,
                      choices: [
                        { message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
                      ],
                    }),
                  ),
                );
              }
              controller.close();
              inFlight--;
            },
          }),
          { headers: { "content-type": streaming ? "text/event-stream" : "application/json" } },
        );
      }

      return new Response("not found", { status: 404 });
    },
  });

  return {
    port: server.port,
    get peakInFlight() {
      return peakInFlight;
    },
    get samples() {
      return samples;
    },
    close() {
      server.stop();
    },
  };
}

async function main() {
  const apiKey = process.env.UMANS_API_KEY;
  if (!apiKey) {
    console.error("UMANS_API_KEY is required");
    process.exit(1);
  }

  console.log("Warming real usage endpoint...");
  const usage = await fetchRealUsage(apiKey);
  console.log(`Real usage limit: ${usage.limit} (hard cap: ${usage.hardCap}, plan: ${usage.plan})`);

  const mock = startCombinedMock(usage);
  const mockUrl = `http://127.0.0.1:${mock.port}`;
  console.log(`Mock upstream listening on ${mockUrl}`);

  const proxy = await startProxy({
    TARGET: mockUrl,
    umansApiKey: apiKey,
    envOverrides: {
      CONCURRENCY_HARD_CAP: process.env.CONCURRENCY_HARD_CAP ?? String(usage.hardCap),
      CONCURRENCY_MAIN_RESERVATION: "1",
      CONCURRENCY_VISION_RESERVATION: "1",
      USAGE_REFRESH_MS: "100",
      VISION_TARGET: `${mockUrl}/v1/chat/completions`,
      VISION_STRATEGY: "always",
    },
  });

  console.log(`Proxy listening on ${proxy.baseUrl}`);
  await sleep(400); // wait for first usage refresh

  console.log("Running burst harness...");
  const result = await runBurst({
    proxyBaseUrl: proxy.baseUrl,
    targetUrl: mockUrl,
    total: 200,
    concurrency: 50,
    waves: 10,
    visionRatio: 0.5,
    sampleIntervalMs: 10,
  });

  const maxGateSample = result.samples.length > 0 ? Math.max(...result.samples) : 0;
  const maxUpstreamSample = mock.samples.length > 0 ? Math.max(...mock.samples) : 0;
  const peak = Math.max(mock.peakInFlight, maxGateSample, maxUpstreamSample);
  const pass = peak <= usage.limit && result.completed === result.sent;

  const report = {
    realLimit: usage.limit,
    realHardCap: usage.hardCap,
    plan: usage.plan,
    sent: result.sent,
    completed: result.completed,
    errored: result.errored,
    durationMs: result.durationMs,
    peakInFlight: mock.peakInFlight,
    maxGateSample,
    maxUpstreamSample,
    overallPeak: peak,
    pass,
  };

  await Bun.write(
    "benchmark/concurrency-gate/results.json",
    JSON.stringify(report, null, 2),
  );

  console.log(JSON.stringify(report, null, 2));
  console.log(pass ? "PASS" : "FAIL");

  await proxy.kill();
  mock.close();
  process.exit(pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
