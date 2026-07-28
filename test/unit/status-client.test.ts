// Unit tests for StatusClient — shared-promise dedup, model bridging,
// fetch failure, fetch timeout, and model-not-in-cache refresh trigger.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ModelEntry, ModelsClient } from "../../src/models.js";
import { StatusClient, type StatusResponse } from "../../src/status-client.js";

/** Build a mock ModelsClient with controllable get() and refresh().
 *  After refresh, `populatedEntries` (if provided) are merged into the map. */
function makeMockModels(
  entries: Map<string, ModelEntry>,
  populatedEntries?: Map<string, ModelEntry>,
): {
  models: ModelsClient;
  refreshCalls: () => number;
} {
  let refreshCalls = 0;
  const models = {
    get: (id: string) => entries.get(id) ?? null,
    refresh: async () => {
      refreshCalls++;
      if (populatedEntries) {
        for (const [k, v] of populatedEntries) entries.set(k, v);
      }
      return true;
    },
  } as unknown as ModelsClient;
  return { models, refreshCalls: () => refreshCalls };
}

function makeModelEntry(baseName?: string): ModelEntry {
  return {
    id: "test-model",
    context_length: 128000,
    pricing: { input: 0, output: 0 },
    weight: 1,
    info:
      baseName !== undefined
        ? {
            name: "test-model",
            display_name: "Test",
            description: "",
            base_model: {
              name: baseName,
              provider: undefined,
              family: undefined,
              oss_base: undefined,
            },
            capabilities: {
              max_completion_tokens: 0,
              recommended_max_tokens: 0,
              context_window: 0,
              supports_vision: false,
              supports_tools: false,
              reasoning: { supported: false, can_disable: false, levels: [], default_level: null },
            },
            benchmarks: {},
            weights: { precision: undefined, hf_url: undefined },
            stage: undefined,
            lifecycle: undefined,
            stamps: {} as never,
          }
        : null,
  };
}

/** Upstream serving /v1/status with a configurable response + call tracking. */
function startStatusUpstream(opts: {
  response?: StatusResponse | null;
  status?: number;
  delayMs?: number;
  port?: number;
}): {
  port: number;
  close: () => Promise<void>;
  getCallCount: () => number;
} {
  let callCount = 0;
  const server = Bun.serve({
    port: opts.port ?? 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/v1/status") {
        return new Response("not found", { status: 404 });
      }
      callCount++;
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      if (opts.status && opts.status !== 200) {
        return new Response("error", { status: opts.status });
      }
      if (opts.response === null) {
        return new Response("not json", { status: 200, headers: { "content-type": "text/plain" } });
      }
      return Response.json(opts.response ?? { models: {}, overall: null });
    },
  });
  return {
    port: server.port!,
    getCallCount: () => callCount,
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        setTimeout(res, 50);
      }),
  };
}

describe("StatusClient — model bridging", () => {
  let upstream: ReturnType<typeof startStatusUpstream>;
  let client: StatusClient;

  beforeAll(() => {
    upstream = startStatusUpstream({
      response: {
        models: {
          "direct-model": {
            latency: { ttft_ms: { p50: 2000 } },
            output_tokens_per_second: { p50: 50 },
          },
          "base-model-x": {
            latency: { ttft_ms: { p50: 30000 } },
            output_tokens_per_second: { p50: 10 },
          },
        },
        overall: { latency: { ttft_ms: { p50: 8000 } } },
      },
    });
    const { models } = makeMockModels(new Map());
    client = new StatusClient({
      target: `http://127.0.0.1:${upstream.port}`,
      apiKey: null,
      models,
    });
  });

  afterAll(async () => {
    await upstream.close();
  });

  test("direct model name match", async () => {
    const result = await client.fetchStatus("direct-model");
    expect(result).not.toBeNull();
    expect(result!.modelP50).toBe(2000);
    expect(result!.tpsP50).toBe(50);
    expect(result!.overallP50).toBe(8000);
  });

  test("sibling bridging via shared base_model.name", async () => {
    // aliased-model is NOT in status; sibling-in-status IS, and both share
    // base_model.name "shared-base". Mirrors umans-coder → umans-kimi-k2.7.
    const up = startStatusUpstream({
      response: {
        models: {
          "sibling-in-status": {
            latency: { ttft_ms: { p50: 30000 } },
            output_tokens_per_second: { p50: 10 },
          },
        },
        overall: { latency: { ttft_ms: { p50: 8000 } } },
      },
    });
    const entries = new Map<string, ModelEntry>([
      ["aliased-model", makeModelEntry("shared-base")],
      ["sibling-in-status", makeModelEntry("shared-base")],
    ]);
    const { models } = makeMockModels(entries);
    const c = new StatusClient({
      target: `http://127.0.0.1:${up.port}`,
      apiKey: null,
      models,
    });
    const result = await c.fetchStatus("aliased-model");
    expect(result).not.toBeNull();
    expect(result!.modelP50).toBe(30000);
    expect(result!.tpsP50).toBe(10);
    await up.close();
  });

  test("overall p50 fallback when model not found", async () => {
    const { models } = makeMockModels(new Map());
    const c = new StatusClient({
      target: `http://127.0.0.1:${upstream.port}`,
      apiKey: null,
      models,
    });
    const result = await c.fetchStatus("unknown-model");
    expect(result).not.toBeNull();
    expect(result!.modelP50).toBe(8000);
    expect(result!.overallP50).toBe(8000);
    expect(result!.tpsP50).toBeNull();
  });

  test("null when no data at all", async () => {
    const up = startStatusUpstream({
      response: { models: {}, overall: null },
    });
    const { models } = makeMockModels(new Map());
    const c = new StatusClient({
      target: `http://127.0.0.1:${up.port}`,
      apiKey: null,
      models,
    });
    const result = await c.fetchStatus("anything");
    expect(result).not.toBeNull();
    expect(result!.modelP50).toBeNull();
    expect(result!.overallP50).toBeNull();
    expect(result!.tpsP50).toBeNull();
    await up.close();
  });

  test("flat (legacy) shape yields null, not NaN — regression for instant-abort bug", async () => {
    // The old/legacy flat shape { p50_ttft_ms, p50_tps } must NOT produce
    // undefined that silently becomes NaN downstream. bridgeModel reads
    // nested paths; missing → null via ?? null. This locks the boundary.
    const up = startStatusUpstream({
      response: {
        models: { "legacy-model": { p50_ttft_ms: 2000, p50_tps: 50 } as never },
        overall: { p50_ttft_ms: 8000 } as never,
      },
    });
    const { models } = makeMockModels(new Map());
    const c = new StatusClient({
      target: `http://127.0.0.1:${up.port}`,
      apiKey: null,
      models,
    });
    const result = await c.fetchStatus("legacy-model");
    expect(result).not.toBeNull();
    expect(result!.modelP50).toBeNull();
    expect(result!.overallP50).toBeNull();
    expect(Number.isFinite(result!.modelP50)).toBe(false);
    await up.close();
  });
});

describe("StatusClient — shared-promise dedup", () => {
  let upstream: ReturnType<typeof startStatusUpstream>;
  let client: StatusClient;

  beforeAll(() => {
    upstream = startStatusUpstream({
      response: {
        models: {
          m: { latency: { ttft_ms: { p50: 1000 } }, output_tokens_per_second: { p50: null } },
        },
        overall: null,
      },
      delayMs: 100,
    });
    const { models } = makeMockModels(new Map());
    client = new StatusClient({
      target: `http://127.0.0.1:${upstream.port}`,
      apiKey: null,
      models,
    });
  });

  afterAll(async () => {
    await upstream.close();
  });

  test("concurrent calls share one fetch", async () => {
    const callsBefore = upstream.getCallCount();
    const [r1, r2, r3] = await Promise.all([
      client.fetchStatus("m"),
      client.fetchStatus("m"),
      client.fetchStatus("m"),
    ]);
    expect(r1!.modelP50).toBe(1000);
    expect(r2!.modelP50).toBe(1000);
    expect(r3!.modelP50).toBe(1000);
    expect(upstream.getCallCount() - callsBefore).toBe(1);
  });
});

describe("StatusClient — fetch failure", () => {
  test("HTTP error returns null", async () => {
    const up = startStatusUpstream({ status: 500 });
    const { models } = makeMockModels(new Map());
    const c = new StatusClient({
      target: `http://127.0.0.1:${up.port}`,
      apiKey: null,
      models,
    });
    const result = await c.fetchStatus("any");
    expect(result).toBeNull();
    await up.close();
  });

  test("non-JSON response returns null", async () => {
    const up = startStatusUpstream({ response: null });
    const { models } = makeMockModels(new Map());
    const c = new StatusClient({
      target: `http://127.0.0.1:${up.port}`,
      apiKey: null,
      models,
    });
    const result = await c.fetchStatus("any");
    expect(result).toBeNull();
    await up.close();
  });

  test("connection refused returns null", async () => {
    const { models } = makeMockModels(new Map());
    const c = new StatusClient({
      target: "http://127.0.0.1:1",
      apiKey: null,
      models,
    });
    const result = await c.fetchStatus("any");
    expect(result).toBeNull();
  });
});

describe("StatusClient — fetch timeout (5s)", () => {
  test("slow upstream returns null", async () => {
    const up = startStatusUpstream({ delayMs: 6000 });
    const { models } = makeMockModels(new Map());
    const c = new StatusClient({
      target: `http://127.0.0.1:${up.port}`,
      apiKey: null,
      models,
    });
    const start = Date.now();
    const result = await c.fetchStatus("any");
    const elapsed = Date.now() - start;
    expect(result).toBeNull();
    expect(elapsed).toBeLessThan(6000);
    await up.close();
  }, 10000);
});

describe("StatusClient — model not in cache triggers refresh", () => {
  test("calls refresh then retries bridging via sibling", async () => {
    const up = startStatusUpstream({
      response: {
        models: {
          "sibling-in-status": {
            latency: { ttft_ms: { p50: 5000 } },
            output_tokens_per_second: { p50: 20 },
          },
        },
        overall: null,
      },
    });
    // my-model not in cache initially; after refresh, both my-model and
    // sibling-in-status appear, sharing base_model.name "shared-base".
    const myEntry = makeModelEntry("shared-base");
    const siblingEntry = makeModelEntry("shared-base");
    const entries = new Map<string, ModelEntry>();
    const populated = new Map<string, ModelEntry>([
      ["my-model", myEntry],
      ["sibling-in-status", siblingEntry],
    ]);
    const { models, refreshCalls } = makeMockModels(entries, populated);
    const c = new StatusClient({
      target: `http://127.0.0.1:${up.port}`,
      apiKey: null,
      models,
    });
    const result = await c.fetchStatus("my-model");
    expect(result).not.toBeNull();
    expect(result!.modelP50).toBe(5000);
    expect(refreshCalls()).toBeGreaterThanOrEqual(1);
    await up.close();
  });
});
