// Test: top_k injection into request bodies.
// Verifies that top_k is injected after model on both routes,
// existing top_k values are preserved, and non-JSON bodies pass through.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "./helpers/proxy";
import { type RawUpstreamHandle, startRawUpstream } from "./helpers/raw-upstream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let raw: RawUpstreamHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  raw = await startRawUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${raw.port}`,
    STAMP_CLAUDE_CODE_ENABLED: "true",
  });
});

afterAll(async () => {
  await proxy.kill();
  await raw.close();
});

async function sendOpenAi(body: string) {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => {});
  await sleep(150);
  return raw.getLastRequest();
}

async function sendAnthropic(body: string) {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => {});
  await sleep(150);
  return raw.getLastRequest();
}

test("openai: top_k injected for umans-glm* model", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBe(20);
  expect(parsed.model).toBe("umans-glm-5.2");
  const keys = Object.keys(parsed);
  expect(keys.indexOf("model")).toBeLessThan(keys.indexOf("top_k"));
});

test("anthropic: top_k injected for umans-glm* model", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await sendAnthropic(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBe(20);
  expect(parsed.model).toBe("umans-glm-5.2");
  const keys = Object.keys(parsed);
  expect(keys.indexOf("model")).toBeLessThan(keys.indexOf("top_k"));
});

test("non-umans-glm models do not get top_k", async () => {
  const body = JSON.stringify({ model: "umans-flash", messages: [] });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBeUndefined();
});

test("existing top_k is preserved (not overwritten)", async () => {
  const body = JSON.stringify({ model: "umans-glm-5.2", top_k: 40, messages: [] });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.top_k).toBe(40);
});

test("STAMP_CLAUDE_CODE_ENABLED=false disables injection", async () => {
  const raw2 = await startRawUpstream();
  const proxy2 = await startProxy({
    TARGET: `http://127.0.0.1:${raw2.port}`,
  });
  try {
    raw2.getLastRequest();
    await fetch(`${proxy2.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "umans-glm-5.2", messages: [] }),
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

test("STAMP_CLAUDE_CODE_ENABLED=true uses hardcoded value 20", async () => {
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
      body: JSON.stringify({ model: "umans-glm-5.2", messages: [] }),
    }).catch(() => {});
    await sleep(150);
    const r = raw3.getLastRequest();
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    expect(parsed.top_k).toBe(20);
  } finally {
    await proxy3.kill();
    await raw3.close();
  }
});
