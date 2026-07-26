// Characterization test: verifies all stamp steps fire in the correct order
// on a single GLM Anthropic request that triggers TTL, AnthropicBody
// (max_tokens + output_config), and TopK stamps simultaneously.
//
// Run: bun test test/stamp-pipeline-order.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  AnthropicBodyStep,
  CacheTtlStep,
  ContextManagementStep,
  OpenAiReasoningStep,
  OpenAiStreamUsageStep,
  RestampBreakpointsStep,
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
      stampClaudeCode: true,
      stampGlm52Thinking: false,
      stampReasoningEffort: null,
      openaiPath: "chat/completions",
      target: "https://api.code.umans.ai",
      captureBodyMaxBytes: 0,
      maxCaptures: 200,
      dbPath: "./umans-gate.db",
      backgroundVision: false,
      concurrencyHardCap: 10,
      concurrencySoftLimit: 5,
      useHardCap: false,
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
      upstreamTimeoutMs: 300000,
      experimentStripOmoReminder: false,
    },
    isOpenAi: false,
    headers: { "content-type": "application/json" },
    url: new URL("http://localhost/v1/messages"),
    method: "POST",
    modelName: undefined,
    catalog: new Map(),
    ...overrides,
  };
}

test("STAMP_PIPELINE has at least 5 steps", () => {
  expect(STAMP_PIPELINE.length).toBeGreaterThanOrEqual(5);
});

test("STAMP_PIPELINE order is RestampBreakpoints, CacheTtl, AnthropicBody, ContextManagement, OpenAiReasoning, OpenAiStreamUsage, TopK", () => {
  expect(STAMP_PIPELINE[0]).toBe(RestampBreakpointsStep);
  expect(STAMP_PIPELINE[1]).toBe(CacheTtlStep);
  expect(STAMP_PIPELINE[2]).toBe(AnthropicBodyStep);
  expect(STAMP_PIPELINE[3]).toBe(ContextManagementStep);
  expect(STAMP_PIPELINE[4]).toBe(OpenAiReasoningStep);
  expect(STAMP_PIPELINE[5]).toBe(OpenAiStreamUsageStep);
  expect(STAMP_PIPELINE[6]).toBe(TopKStep);
});

test("RestampBreakpointsStep.applies is true for Anthropic requests with stampClaudeCode enabled", () => {
  const ctx = makeCtx({ isOpenAi: false });
  expect(RestampBreakpointsStep.applies(ctx)).toBe(true);
});

test("RestampBreakpointsStep.applies is false for OpenAI requests", () => {
  const ctx = makeCtx({ isOpenAi: true });
  expect(RestampBreakpointsStep.applies(ctx)).toBe(false);
});

test("RestampBreakpointsStep.applies is false when stampClaudeCode is false (disabled)", () => {
  const ctx = makeCtx({ config: { ...makeCtx().config, stampClaudeCode: false } });
  expect(RestampBreakpointsStep.applies(ctx)).toBe(false);
});

test("CacheTtlStep.applies is true for Anthropic requests with stampClaudeCode enabled", () => {
  const ctx = makeCtx({ isOpenAi: false });
  expect(CacheTtlStep.applies(ctx)).toBe(true);
});

test("CacheTtlStep.applies is false for OpenAI requests", () => {
  const ctx = makeCtx({ isOpenAi: true });
  expect(CacheTtlStep.applies(ctx)).toBe(false);
});

test("CacheTtlStep.applies is false when stampClaudeCode is false (disabled)", () => {
  const ctx = makeCtx({ config: { ...makeCtx().config, stampClaudeCode: false } });
  expect(CacheTtlStep.applies(ctx)).toBe(false);
});

test("TopKStep.applies is true when stampClaudeCode enabled and model is GLM", () => {
  const ctx = makeCtx({ modelName: "umans-glm-5.2" });
  expect(TopKStep.applies(ctx)).toBe(true);
});

test("TopKStep.applies is false when stampClaudeCode is false (disabled)", () => {
  const ctx = makeCtx({
    modelName: "umans-glm-5.2",
    config: { ...makeCtx().config, stampClaudeCode: false },
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

test("OpenAiStreamUsageStep.applies is true for OpenAI streaming requests with reasoning enabled", () => {
  const ctx = makeCtx({
    isOpenAi: true,
    config: { ...makeCtx().config, stampReasoningEffort: "high" },
  });
  expect(OpenAiStreamUsageStep.applies(ctx)).toBe(true);
});

test("OpenAiStreamUsageStep.applies is false when stampReasoningEffort is null (disabled)", () => {
  const ctx = makeCtx({
    isOpenAi: true,
    config: { ...makeCtx().config, stampReasoningEffort: null },
  });
  expect(OpenAiStreamUsageStep.applies(ctx)).toBe(false);
});

test("OpenAiStreamUsageStep.applies is false for Anthropic requests", () => {
  const ctx = makeCtx({
    isOpenAi: false,
    config: { ...makeCtx().config, stampReasoningEffort: "high" },
  });
  expect(OpenAiStreamUsageStep.applies(ctx)).toBe(false);
});

test("OpenAiStreamUsageStep.apply injects stream_options.include_usage on streaming requests", () => {
  const ctx = makeCtx({
    isOpenAi: true,
    config: { ...makeCtx().config, stampReasoningEffort: "high" },
  });
  const body: Record<string, unknown> = { stream: true, model: "gpt-4" };
  const changed = OpenAiStreamUsageStep.apply(body, ctx);
  expect(changed).toBe(true);
  expect(body.stream_options).toEqual({ include_usage: true });
});

test("OpenAiStreamUsageStep.apply is idempotent when include_usage already true", () => {
  const ctx = makeCtx({
    isOpenAi: true,
    config: { ...makeCtx().config, stampReasoningEffort: "high" },
  });
  const body: Record<string, unknown> = {
    stream: true,
    stream_options: { include_usage: true },
    model: "gpt-4",
  };
  const changed = OpenAiStreamUsageStep.apply(body, ctx);
  expect(changed).toBe(false);
  expect(body.stream_options).toEqual({ include_usage: true });
});

test("OpenAiStreamUsageStep.apply skips non-streaming requests", () => {
  const ctx = makeCtx({
    isOpenAi: true,
    config: { ...makeCtx().config, stampReasoningEffort: "high" },
  });
  const body: Record<string, unknown> = { model: "gpt-4" };
  const changed = OpenAiStreamUsageStep.apply(body, ctx);
  expect(changed).toBe(false);
  expect(body.stream_options).toBeUndefined();
});

test("AnthropicBodyStep.applies is true when stampClaudeCode is enabled", () => {
  const ctx = makeCtx({ isOpenAi: false });
  expect(AnthropicBodyStep.applies(ctx)).toBe(true);
});

test("ContextManagementStep.applies is true when stampClaudeCode enabled", () => {
  const ctx = makeCtx({
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  });
  expect(ContextManagementStep.applies(ctx)).toBe(true);
});

test("ContextManagementStep.applies is true when stampClaudeCode enabled (regardless of client-sent version)", () => {
  const ctx = makeCtx({ headers: { "content-type": "application/json" } });
  expect(ContextManagementStep.applies(ctx)).toBe(true);
});

test("ContextManagementStep.applies is false for OpenAI requests", () => {
  const ctx = makeCtx({
    isOpenAi: true,
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
  });
  expect(ContextManagementStep.applies(ctx)).toBe(false);
});

// ─── Integration test: end-to-end pipeline on a real proxy ─────────────────

let raw: RawUpstreamHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  raw = await startRawUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${raw.port}`,
    STAMP_CLAUDE_CODE_ENABLED: "true",
    STAMP_GLM_5_2_THINKING_ENABLED: "true",
  });
});

afterAll(async () => {
  await proxy.kill();
  await raw.close();
});

test("all stamp steps fire in order on a single GLM Anthropic request", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    thinking: { type: "adaptive" },
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
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
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

  // --- AnthropicBody (runs second: max_tokens + thinking + output_config) ---
  expect(parsed.max_tokens).toBe(131071);
  expect(parsed.thinking).toEqual({ type: "enabled", clear_thinking: false, budget_tokens: 32000 });
  expect(parsed.output_config).toEqual({ effort: "max" });

  // --- ContextManagement (runs third: injects context_management) ---
  expect(parsed.context_management).toEqual({
    edits: [{ type: "clear_thinking_20251015", keep: "all" }],
  });

  expect(parsed.temperature).toBe(1.0);

  // --- TTL (runs after restamp: stamps cache_control ephemeral blocks with ttl) ---
  expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(parsed.messages[0].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
});

test("restamp converts tip-riding breakpoints to Layout B and TTL step stamps the new last-user breakpoint", async () => {
  // Input has tip-riding breakpoints: sys[0] + assistant tool_use + user tool_result.
  // Restamp should strip the tip breakpoints and place one on the last user block.
  // TTL step should then stamp ttl:"1h" on both system[0] and the new last-user breakpoint.
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    max_tokens: 50,
    system: [{ type: "text", text: "You are helpful.", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "first user" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "reply" },
          {
            type: "tool_use",
            id: "t1",
            name: "n",
            input: {},
            cache_control: { type: "ephemeral" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "t1",
            content: "r",
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ],
  });

  raw.getLastRequest(); // clear any previous
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body,
  }).catch(() => {});
  await sleep(150);
  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);

  // --- Restamp ran first: stripped tip breakpoints, placed one on last user block ---
  // system[0] breakpoint preserved
  expect(parsed.system[0].cache_control?.type).toBe("ephemeral");
  // assistant tool_use block breakpoint stripped
  expect(parsed.messages[1].content[1].cache_control).toBeUndefined();
  // user tool_result block (now the last user block) got a new breakpoint
  expect(parsed.messages[2].content[0].cache_control?.type).toBe("ephemeral");

  // --- TTL ran second: stamped ttl:"1h" on both restamped breakpoints ---
  expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
  expect(parsed.messages[2].content[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
});

// ─── Respect-if-present integration tests (ADR-0008) ──────────────────────

test("anthropic without thinking: only TTL stamped, no body fields", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    max_tokens: 50,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  });

  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body,
  }).catch(() => {});
  await sleep(150);
  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);

  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
  expect(parsed.temperature).toBeUndefined();
  expect(parsed.max_tokens).toBe(50);
  expect(parsed.top_k).toBeUndefined();
  expect(parsed.context_management).toBeUndefined();
  expect(parsed.system[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
});

test("anthropic with thinking disabled: respected, no body stamps except TTL", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    thinking: { type: "disabled" },
    max_tokens: 50,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  });

  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body,
  }).catch(() => {});
  await sleep(150);
  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);

  expect(parsed.thinking).toEqual({ type: "disabled" });
  expect(parsed.output_config).toBeUndefined();
  expect(parsed.temperature).toBeUndefined();
  expect(parsed.max_tokens).toBe(50);
  expect(parsed.top_k).toBeUndefined();
  expect(parsed.context_management).toBeUndefined();
});

test("anthropic with thinking adaptive: respected, output_config stamped, temperature forced", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    thinking: { type: "adaptive" },
    max_tokens: 50,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  });

  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body,
  }).catch(() => {});
  await sleep(150);
  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);

  // thinking forced to GLM Preserved Thinking shape (clear_thinking:false)
  expect(parsed.thinking).toEqual({ type: "enabled", clear_thinking: false, budget_tokens: 32000 });
  // output_config IS stamped (thinking is enabled)
  expect(parsed.output_config).toEqual({ effort: "max" });
  // temperature IS forced (thinking is enabled)
  expect(parsed.temperature).toBe(1.0);
  // max_tokens IS stamped
  expect(parsed.max_tokens).toBe(131071);
});

test("umans-coder with non-adaptive thinking: forced to adaptive end-to-end", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    thinking: { type: "enabled", budget_tokens: 1024 },
    max_tokens: 50,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  });

  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body,
  }).catch(() => {});
  await sleep(150);
  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);

  // GLM 5.2 child toggle is ON but umans-coder does not match "5.2" → adaptive fallback.
  expect(parsed.thinking).toEqual({ type: "adaptive" });
  expect(parsed.output_config).toEqual({ effort: "high" });
  expect(parsed.temperature).toBe(1.0);
  expect(parsed.max_tokens).toBe(32767);
});

test("umans-coder with disabled thinking: forced to adaptive (canDisable=false)", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    thinking: { type: "disabled" },
    max_tokens: 50,
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: "hi" }],
  });

  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
    body,
  }).catch(() => {});
  await sleep(150);
  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);

  // canDisableThinking=false forces the block; shape is adaptive (GLM 5.2 toggle version mismatch).
  expect(parsed.thinking).toEqual({ type: "adaptive" });
  expect(parsed.output_config).toEqual({ effort: "high" });
  expect(parsed.temperature).toBe(1.0);
});

// ─── OpenAI respect-if-present integration tests ──────────────────────────

let openaiRaw: RawUpstreamHandle;
let openaiProxy: ProxyHandle;

beforeAll(async () => {
  openaiRaw = await startRawUpstream();
  openaiProxy = await startProxy({
    TARGET: `http://127.0.0.1:${openaiRaw.port}`,
    STAMP_REASONING_EFFORT_ENABLED: "true",
  });
});

afterAll(async () => {
  await openaiProxy.kill();
  await openaiRaw.close();
});

test("openai with thinking enabled: reasoning_effort injected, thinking stripped", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: "hi" }],
  });

  openaiRaw.getLastRequest();
  await fetch(`${openaiProxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => {});
  await sleep(150);
  const r = openaiRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);

  expect(parsed.reasoning_effort).toBe("max");
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.max_tokens).toBe(4096);
});

test("openai with reasoning_effort=none: respected for canDisable=true (umans-glm)", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    reasoning_effort: "none",
    max_tokens: 4096,
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: "hi" }],
  });

  openaiRaw.getLastRequest();
  await fetch(`${openaiProxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => {});
  await sleep(150);
  const r = openaiRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);

  expect(parsed.reasoning_effort).toBe("none");
  expect(parsed.max_tokens).toBe(4096);
  expect(parsed.thinking).toEqual({ type: "adaptive" });
});

test("openai with reasoning_effort=high: forced to max (umans-glm), thinking stripped", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    reasoning_effort: "high",
    max_tokens: 8192,
    thinking: { type: "enabled" },
    messages: [{ role: "user", content: "hi" }],
  });

  openaiRaw.getLastRequest();
  await fetch(`${openaiProxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => {});
  await sleep(150);
  const r = openaiRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);

  expect(parsed.reasoning_effort).toBe("max");
  expect(parsed.max_tokens).toBe(8192);
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.temperature).toBe(1.0);
});
