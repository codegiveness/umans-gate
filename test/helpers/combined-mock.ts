// Combined mock upstream + usage endpoint for concurrency-gate integration tests.
// Serves both /v1/usage (so the proxy's usage client can fetch the limit) and
// /v1/chat/completions (so the proxy actually forwards traffic to a tracker).

import type { Server } from "bun";

export interface CombinedMockConfig {
  limit: number;
  hardCap?: number;
  planName?: string;
  delayMs?: number;
  port?: number;
}

export interface CombinedMockHandle {
  port: number;
  inFlight: number;
  peakInFlight: number;
  totalRequests: number;
  samples: number[];
  setLimit(n: number): void;
  close(): Promise<void>;
}

interface RawUsage {
  plan: { display_name: string };
  limits: {
    concurrency: {
      limit: number;
      hard_cap: number;
      burst_pct: number;
    };
  };
  usage: {
    requests_in_window: number;
    remaining_requests: number | null;
    concurrent_sessions: number;
    priority: {
      low: boolean;
      boxed_until: number | null;
    };
  };
}

export function startCombinedMock(config: CombinedMockConfig): CombinedMockHandle {
  const delayMs = config.delayMs ?? 120;
  let limit = config.limit;
  let hardCap = config.hardCap ?? limit;

  let inFlight = 0;
  let peakInFlight = 0;
  let totalRequests = 0;
  const samples: number[] = [];

  const buildUsage = (): RawUsage => ({
    plan: { display_name: config.planName ?? "Code Pro" },
    limits: {
      concurrency: {
        limit,
        hard_cap: hardCap,
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

  const server: Server<unknown> = Bun.serve({
    port: config.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/v1/usage") {
        return Response.json(buildUsage());
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [] });
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (await req.json().catch(() => ({}))) as { stream?: boolean };
        const streaming = body.stream === true;
        const id = `chatcmpl-combined-${totalRequests + 1}`;
        const enc = new TextEncoder();

        totalRequests++;
        inFlight++;
        peakInFlight = Math.max(peakInFlight, inFlight);
        samples.push(inFlight);

        return new Response(
          new ReadableStream<Uint8Array>({
            async start(controller) {
              await Bun.sleep(delayMs);
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
    get port() {
      return server.port ?? 0;
    },
    get inFlight() {
      return inFlight;
    },
    get peakInFlight() {
      return peakInFlight;
    },
    get totalRequests() {
      return totalRequests;
    },
    get samples() {
      return samples;
    },
    setLimit(n: number) {
      limit = n;
      if (hardCap === limit) {
        hardCap = n;
      }
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        server.stop();
        resolve();
      });
    },
  };
}
