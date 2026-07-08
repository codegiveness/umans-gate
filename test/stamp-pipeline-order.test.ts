// Characterization test: verifies all stamp steps fire in the correct order
// on a single GLM Anthropic request that triggers TTL, AnthropicBody
// (max_tokens + output_config), and TopK stamps simultaneously.
//
// Run: bun test test/stamp-pipeline-order.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AnthropicBodyStep,
  CacheTtlStep,
  OpenAiReasoningStep,
  STAMP_PIPELINE,
  type StampContext,
  TopKStep,
} from "../src/stamp-pipeline.js";
import { type ProxyHandle, startProxy } from "./helpers/proxy";
import { type RawUpstreamHandle, startRawUpstream } from "./helpers/raw-upstream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Unit-level characterization of the pipeline structure ─────────────────
// These tests import directly from src/stamp-pipeline.ts and do NOT spawn
// a proxy. They lock the pipeline shape and step applicability predicates.

/** Minimal StampContext for unit tests — only fields the .applies predicates read. */
function makeCtx(overrides: Partial<StampContext> = {}): StampContext {
  return {
    config: {
      stampTtl: "1h",
      stampTopK: 20,
      stampMaxTokens: 32000,
      stampThinking: null,
      stampOutputConfig: { effort: "high" },
      stampReasoningEffort: null,
      openaiPath: "chat/completions",
      target: "https://api.code.umans.ai",
      captureBodyMaxBytes: 0,
      maxCaptures: 200,
      dbPath: "./umans-gate.db",
      concurrencyHardCap: 10,
      concurrencySoftLimit: 5,
      concurrencyWeights: {},
      rateLimitRequests: 0,
      queueTimeoutMs: 30000,
      maxQueueDepth: 100,
      releaseCooldownMs: 0,
      breakerThreshold: 5,
      breakerWindowMs: 60000,
      breakerCooldownMs: 30000,
      concurrencyMainReservation: 1,
      concurrencyVisionReservation: 1,
      incomingProtocol: "http1.1",
      upstreamProtocol: "http1.1",
    },
    isOpenAi: false,
    headers: { "content-type": "application/json" },
    url: new URL("http://localhost/v1/messages"),
    method: "POST",
    modelName: undefined,
    ...overrides,
  };
}

test("STAMP_PIPELINE has at least 4 steps", () => {
  expect(STAMP_PIPELINE.length).toBeGreaterThanOrEqual(4);
});

test("STAMP_PIPELINE order is CacheTtl, AnthropicBody, OpenAiReasoning, TopK", () => {
  expect(STAMP_PIPELINE[0]).toBe(CacheTtlStep);
  expect(STAMP_PIPELINE[1]).toBe(AnthropicBodyStep);
  expect(STAMP_PIPELINE[2]).toBe(OpenAiReasoningStep);
  expect(STAMP_PIPELINE[3]).toBe(TopKStep);
});

test("CacheTtlStep.applies is true for Anthropic requests with stampTtl enabled", () => {
  const ctx = makeCtx({ isOpenAi: false });
  expect(CacheTtlStep.applies(ctx)).toBe(true);
});

test("CacheTtlStep.applies is false for OpenAI requests", () => {
  const ctx = makeCtx({ isOpenAi: true });
  expect(CacheTtlStep.applies(ctx)).toBe(false);
});

test("CacheTtlStep.applies is false when stampTtl is null (disabled)", () => {
  const ctx = makeCtx({ config: { ...makeCtx().config, stampTtl: null } });
  expect(CacheTtlStep.applies(ctx)).toBe(false);
});

test("TopKStep.applies is true when stampTopK enabled and model is GLM", () => {
  const ctx = makeCtx({ modelName: "umans-glm-5.2" });
  expect(TopKStep.applies(ctx)).toBe(true);
});

test("TopKStep.applies is false when stampTopK is null (disabled)", () => {
  const ctx = makeCtx({
    modelName: "umans-glm-5.2",
    config: { ...makeCtx().config, stampTopK: null },
  });
  expect(TopKStep.applies(ctx)).toBe(false);
});

test("TopKStep.applies is false for non-GLM models", () => {
  const ctx = makeCtx({ modelName: "claude-sonnet-4" });
  expect(TopKStep.applies(ctx)).toBe(false);
});

test("OpenAiReasoningStep.applies is true for OpenAI requests with reasoning enabled", () => {
  const ctx = makeCtx({
    isOpenAi: true,
    config: { ...makeCtx().config, stampReasoningEffort: "high" },
  });
  expect(OpenAiReasoningStep.applies(ctx)).toBe(true);
});

test("AnthropicBodyStep.applies is true when any body stamp is enabled", () => {
  const ctx = makeCtx({ isOpenAi: false });
  expect(AnthropicBodyStep.applies(ctx)).toBe(true);
});

// ─── Integration test: end-to-end pipeline on a real proxy ─────────────────

let raw: RawUpstreamHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  raw = await startRawUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${raw.port}`,
    STAMP_CACHE_TTL_ENABLED: "true",
    STAMP_MAX_TOKENS_ENABLED: "true",
    STAMP_THINKING_ENABLED: "true",
    STAMP_OUTPUT_CONFIG_ENABLED: "true",
    STAMP_TOP_K_ENABLED: "true",
  });
});

afterAll(async () => {
  await proxy.kill();
  await raw.close();
});

test("all stamp steps fire in order on a single GLM Anthropic request", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    max_tokens: 50,
    system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello", cache_control: { type: "ephemeral" } }],
      },
    ],
  });

  raw.getLastRequest(); // clear any previous
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => {});
  await sleep(150);
  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);

  // --- TopK (runs last, rebuilds key order: model, top_k, then rest) ---
  expect(parsed.model).toBe("umans-glm-5.2");
  expect(parsed.top_k).toBe(20);
  const keys = Object.keys(parsed);
  expect(keys[0]).toBe("model");
  expect(keys[1]).toBe("top_k");

  // --- AnthropicBody (runs second: max_tokens + output_config) ---
  // thinking is NOT stamped for umans-glm models (only umans-coder/flash/kimi*/qwen*)
  expect(parsed.max_tokens).toBe(32000);
  expect(parsed.output_config).toEqual({ effort: "max" });
  expect(parsed.thinking).toBeUndefined();

  // --- TTL (runs first: stamps cache_control ephemeral blocks with ttl) ---
  expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
});
