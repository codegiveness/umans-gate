// Burst concurrency harness: fires mixed vision/plain requests at the proxy
// while polling gate stats.

import type { GateStats } from "../../dashboard/src/types.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface BurstConfig {
  proxyBaseUrl: string;
  targetUrl: string;
  total: number;
  concurrency: number;
  waves: number;
  visionRatio: number;
  sampleIntervalMs: number;
}

export interface BurstResult {
  sent: number;
  completed: number;
  errored: number;
  peakInFlight: number;
  samples: number[];
  gateStatsSamples: GateStats[];
  durationMs: number;
}

const TINY_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function makeVisionBody(): unknown {
  return {
    model: "test-vision",
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "describe this" },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${TINY_PNG_BASE64}`,
            },
          },
        ],
      },
    ],
  };
}

function makePlainBody(): unknown {
  return {
    model: "test",
    messages: [{ role: "user", content: "hi" }],
  };
}

async function fetchGate(baseUrl: string): Promise<GateStats | null> {
  try {
    const res = await fetch(`${baseUrl}/dashboard/api/gate`);
    if (!res.ok) return null;
    return (await res.json()) as GateStats;
  } catch {
    return null;
  }
}

export async function runBurst(config: BurstConfig): Promise<BurstResult> {
  const { proxyBaseUrl, total, concurrency, waves, visionRatio, sampleIntervalMs } = config;

  const results: PromiseSettledResult<Response>[] = [];
  const samples: number[] = [];
  const gateStatsSamples: GateStats[] = [];
  let polling = true;

  const pollLoop = async () => {
    while (polling) {
      const stats = await fetchGate(proxyBaseUrl);
      if (stats) {
        samples.push(stats.active);
        gateStatsSamples.push(stats);
      }
      await sleep(sampleIntervalMs);
    }
  };

  const startTime = performance.now();
  const pollTask = pollLoop();

  const perWave = Math.ceil(total / waves);
  let sentCount = 0;

  for (let w = 0; w < waves && sentCount < total; w++) {
    const remaining = total - sentCount;
    const waveSize = Math.min(perWave, remaining);
    const waveBatches = Math.ceil(waveSize / concurrency);

    for (let b = 0; b < waveBatches; b++) {
      const batchRemaining = waveSize - b * concurrency;
      const batchSize = Math.min(concurrency, batchRemaining);

      const batch = Array.from({ length: batchSize }, () => {
        const isVision = Math.random() < visionRatio;
        const body = isVision ? makeVisionBody() : makePlainBody();
        return fetch(`${proxyBaseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      });

      const settled = await Promise.allSettled(batch);
      results.push(...settled);
      sentCount += batchSize;
    }

    if (w < waves - 1) {
      await sleep(0);
    }
  }

  polling = false;
  await pollTask;

  const durationMs = Math.round(performance.now() - startTime);

  const completed = results.filter(
    (r): r is PromiseFulfilledResult<Response> => r.status === "fulfilled",
  ).length;
  const errored = results.length - completed;
  const peakInFlight = samples.length > 0 ? Math.max(...samples) : 0;

  return {
    sent: sentCount,
    completed,
    errored,
    peakInFlight,
    samples,
    gateStatsSamples,
    durationMs,
  };
}
