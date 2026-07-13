// Test: temperature forcing on request bodies.
// Verifies that temperature is forced to 1.0 on both OpenAI and Anthropic
// routes, existing values are overwritten, and disabled flag skips injection.

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

test("openai: temperature forced to 1.0 when absent", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.temperature).toBe(1.0);
});

test("anthropic: temperature forced to 1.0 when absent", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await sendAnthropic(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.temperature).toBe(1.0);
});

test("existing temperature is overwritten to 1.0", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    temperature: 0.5,
    messages: [],
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.temperature).toBe(1.0);
});

test("STAMP_CLAUDE_CODE_ENABLED=false skips temperature injection", async () => {
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
    expect(parsed.temperature).toBeUndefined();
  } finally {
    await proxy2.kill();
    await raw2.close();
  }
});

test("temperature forced on non-GLM models too", async () => {
  const body = JSON.stringify({
    model: "umans-flash",
    messages: [],
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.temperature).toBe(1.0);
});
