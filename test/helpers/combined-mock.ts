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
  setPriority(state: { low?: boolean; boxedUntil?: number | null; reason?: string | null }): void;
  setServiceMode(state: { current?: string; resetsAt?: number | null }): void;
  setTokens(state: { tokensIn?: number; tokensOut?: number; tokensCached?: number }): void;
  setPriorityBudget(entries: RawPriorityBudgetEntry[] | null): void;
  /** Set the unweighted requests-window usage the /v1/usage endpoint reports.
   *  Backs the rate-gate data source (requestsInWindow + requests limits).
   *  Only the fields passed are changed; omitted fields keep their current value.
   */
  setUsage(state: {
    requestsInWindow?: number;
    requestsHardCap?: number | null;
    requestsLimit?: number | null;
  }): void;
  close(): Promise<void>;
}

export interface RawPriorityBudgetEntry {
  category: string;
  label: string;
  models: string[];
  used_pct: number;
  over_budget_today: boolean;
  mode: string;
  resets_at: string | number | null;
}

interface RawUsage {
  plan: { display_name: string };
  limits: {
    concurrency: {
      limit: number;
      hard_cap: number;
      burst_pct: number;
    };
    requests?: {
      limit?: number;
      hard_cap?: number;
      window_seconds?: number;
    };
  };
  usage: {
    requests_in_window: number;
    remaining_requests: number | null;
    concurrent_sessions: number;
    tokens_in: number;
    tokens_out: number;
    tokens_cached: number;
    priority: {
      low: boolean;
      boxed_until: number | null;
      reason: string | null;
    };
    service_mode: {
      current: string;
      resets_at: number | null;
    };
    priority_budget?: RawPriorityBudgetEntry[];
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

  let priorityLow = false;
  let boxedUntil: number | null = null;
  let boxedReason: string | null = null;
  let serviceModeCurrent = "normal";
  let serviceModeResetsAt: number | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let tokensCached = 0;
  let priorityBudget: RawPriorityBudgetEntry[] | null = null;

  // Unweighted requests-window state backing the rate-gate data source.
  // Set via setUsage(). The limits.requests block is emitted only once setUsage
  // supplied at least one request-limit field — before that, /v1/usage reports
  // no requests limits (parser leaves requestsHardCap/requestsLimit null),
  // preserving the pre-existing concurrency-only behavior of other tests.
  let requestsInWindow = 0;
  let requestsHardCap: number | null = null;
  let requestsLimit: number | null = null;
  let requestsHardCapSet = false;
  let requestsLimitSet = false;

  const buildUsage = (): RawUsage => ({
    plan: { display_name: config.planName ?? "Code Pro" },
    limits: {
      concurrency: {
        limit,
        hard_cap: hardCap,
        burst_pct: 0,
      },
      ...(requestsHardCapSet || requestsLimitSet
        ? {
            requests: {
              ...(requestsHardCapSet ? { hard_cap: requestsHardCap ?? null } : {}),
              ...(requestsLimitSet ? { limit: requestsLimit ?? null } : {}),
              window_seconds: 60,
            },
          }
        : {}),
    },
    usage: {
      requests_in_window: requestsInWindow,
      remaining_requests: null,
      concurrent_sessions: 0,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      tokens_cached: tokensCached,
      priority: { low: priorityLow, boxed_until: boxedUntil, reason: boxedReason },
      service_mode: { current: serviceModeCurrent, resets_at: serviceModeResetsAt },
      ...(priorityBudget !== null ? { priority_budget: priorityBudget } : {}),
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
                    })}\n\n`,
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
    setPriority(state: { low?: boolean; boxedUntil?: number | null; reason?: string | null }) {
      if (state.low !== undefined) priorityLow = state.low;
      if (state.boxedUntil !== undefined) boxedUntil = state.boxedUntil;
      if (state.reason !== undefined) boxedReason = state.reason;
    },
    setServiceMode(state: { current?: string; resetsAt?: number | null }) {
      if (state.current !== undefined) serviceModeCurrent = state.current;
      if (state.resetsAt !== undefined) serviceModeResetsAt = state.resetsAt;
    },
    setTokens(state: { tokensIn?: number; tokensOut?: number; tokensCached?: number }) {
      if (state.tokensIn !== undefined) tokensIn = state.tokensIn;
      if (state.tokensOut !== undefined) tokensOut = state.tokensOut;
      if (state.tokensCached !== undefined) tokensCached = state.tokensCached;
    },
    setPriorityBudget(entries: RawPriorityBudgetEntry[] | null) {
      priorityBudget = entries;
    },
    setUsage(state: {
      requestsInWindow?: number;
      requestsHardCap?: number | null;
      requestsLimit?: number | null;
    }) {
      if (state.requestsInWindow !== undefined) requestsInWindow = state.requestsInWindow;
      if (state.requestsHardCap !== undefined) {
        requestsHardCap = state.requestsHardCap;
        requestsHardCapSet = true;
      }
      if (state.requestsLimit !== undefined) {
        requestsLimit = state.requestsLimit;
        requestsLimitSet = true;
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
