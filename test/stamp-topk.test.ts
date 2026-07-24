// Test: top_k injection into request bodies.
// Verifies that top_k is injected after model on both routes,
// existing top_k values are preserved, and non-JSON bodies pass through.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "./helpers/proxy";
import { type RawUpstreamHandle, startRawUpstream } from "./helpers/raw-upstream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── Anthropic route (stampClaudeCode) ─────────────────────────────────────

let anthropicRaw: RawUpstreamHandle;
let anthropicProxy: ProxyHandle;

beforeAll(async () => {
  anthropicRaw = await startRawUpstream();
  anthropicProxy = await startProxy({
    TARGET: `http://127.0.0.1:${anthropicRaw.port}`,
    STAMP_CLAUDE_CODE_ENABLED: "true",
  });
});

afterAll(async () => {
  await anthropicProxy.kill();
  await anthropicRaw.close();
});

test("anthropic: top_k injected for umans-glm* when thinking enabled", async () => {
  anthropicRaw.getLastRequest();
  await fetch(`${anthropicProxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    }),
  }).catch(() => {});
  await sleep(150);
  const r = anthropicRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBe(20);
  expect(parsed.model).toBe("umans-glm-5.2");
  const keys = Object.keys(parsed);
  expect(keys.indexOf("model")).toBeLessThan(keys.indexOf("top_k"));
});

test("anthropic: top_k NOT injected when thinking absent", async () => {
  anthropicRaw.getLastRequest();
  await fetch(`${anthropicProxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    }),
  }).catch(() => {});
  await sleep(150);
  const r = anthropicRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBeUndefined();
});

test("anthropic: non-glm models do not get top_k even with thinking", async () => {
  anthropicRaw.getLastRequest();
  await fetch(`${anthropicProxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-flash",
      thinking: { type: "adaptive" },
      messages: [],
    }),
  }).catch(() => {});
  await sleep(150);
  const r = anthropicRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBeUndefined();
});

test("anthropic: existing top_k preserved (not overwritten) with thinking", async () => {
  anthropicRaw.getLastRequest();
  await fetch(`${anthropicProxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      top_k: 40,
      thinking: { type: "adaptive" },
      messages: [],
    }),
  }).catch(() => {});
  await sleep(150);
  const r = anthropicRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBe(40);
});

// ─── OpenAI route (stampReasoningEffort) ───────────────────────────────────

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

test("openai: top_k injected for umans-glm* when reasoning_effort present", async () => {
  openaiRaw.getLastRequest();
  await fetch(`${openaiProxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      reasoning_effort: "high",
      messages: [{ role: "user", content: "hi" }],
    }),
  }).catch(() => {});
  await sleep(150);
  const r = openaiRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBe(20);
  expect(parsed.model).toBe("umans-glm-5.2");
  const keys = Object.keys(parsed);
  expect(keys.indexOf("model")).toBeLessThan(keys.indexOf("top_k"));
});

test("openai: top_k injected when thinking triggers reasoning_effort injection", async () => {
  openaiRaw.getLastRequest();
  await fetch(`${openaiProxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    }),
  }).catch(() => {});
  await sleep(150);
  const r = openaiRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBe(20);
  expect(parsed.reasoning_effort).toBe("max");
  expect(parsed.thinking).toBeUndefined();
});

test("openai: top_k NOT injected when reasoning_effort absent", async () => {
  openaiRaw.getLastRequest();
  await fetch(`${openaiProxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      messages: [{ role: "user", content: "hi" }],
    }),
  }).catch(() => {});
  await sleep(150);
  const r = openaiRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBeUndefined();
});

test("openai: non-glm models do not get top_k even with reasoning", async () => {
  openaiRaw.getLastRequest();
  await fetch(`${openaiProxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-flash",
      reasoning_effort: "high",
      messages: [],
    }),
  }).catch(() => {});
  await sleep(150);
  const r = openaiRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBeUndefined();
});

test("openai: existing top_k preserved (not overwritten) with reasoning", async () => {
  openaiRaw.getLastRequest();
  await fetch(`${openaiProxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-glm-5.2",
      top_k: 40,
      reasoning_effort: "high",
      messages: [],
    }),
  }).catch(() => {});
  await sleep(150);
  const r = openaiRaw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBe(40);
});

// ─── Toggle-off tests ──────────────────────────────────────────────────────

test("stampClaudeCode disabled: no top_k on anthropic route", async () => {
  const raw2 = await startRawUpstream();
  const proxy2 = await startProxy({
    TARGET: `http://127.0.0.1:${raw2.port}`,
  });
  try {
    raw2.getLastRequest();
    await fetch(`${proxy2.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        thinking: { type: "adaptive" },
        messages: [],
      }),
    }).catch(() => {});
    await sleep(150);
    const r = raw2.getLastRequest();
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    expect(parsed.top_k).toBeUndefined();
  } finally {
    await proxy2.kill();
    await raw2.close();
  }
});

test("stampReasoningEffort disabled: no top_k on openai route", async () => {
  const raw3 = await startRawUpstream();
  const proxy3 = await startProxy({
    TARGET: `http://127.0.0.1:${raw3.port}`,
    STAMP_CLAUDE_CODE_ENABLED: "true",
  });
  try {
    raw3.getLastRequest();
    await fetch(`${proxy3.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        reasoning_effort: "high",
        messages: [],
      }),
    }).catch(() => {});
    await sleep(150);
    const r = raw3.getLastRequest();
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    expect(parsed.top_k).toBeUndefined();
  } finally {
    await proxy3.kill();
    await raw3.close();
  }
});
