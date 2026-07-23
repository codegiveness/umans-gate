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
    STAMP_REASONING_EFFORT_ENABLED: "true",
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

test("OpenAI route does NOT inject reasoning_effort for non-glm model (respect-if-present)", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 4096,
    thinking: { type: "enabled" },
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  // max_tokens preserved (not stripped)
  expect(parsed.max_tokens).toBe(4096);
  // thinking preserved (not stripped)
  expect(parsed.thinking).toEqual({ type: "enabled" });
  // reasoning_effort NOT injected
  expect(parsed.reasoning_effort).toBeUndefined();
});

test("OpenAI route does NOT inject reasoning_effort for umans-glm* model (respect-if-present)", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  // reasoning_effort NOT injected
  expect(parsed.reasoning_effort).toBeUndefined();
});

test("OpenAI route is not stamped when toggle disabled", async () => {
  const raw2 = await startRawUpstream();
  const proxy2 = await startProxy({
    TARGET: `http://127.0.0.1:${raw2.port}`,
    STAMP_REASONING_EFFORT_ENABLED: "false",
  });
  try {
    raw2.getLastRequest();
    await fetch(`${proxy2.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-coder",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 4096,
      }),
    }).catch(() => {});
    await sleep(150);
    const r = raw2.getLastRequest();
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    expect(parsed.max_tokens).toBe(4096);
    expect(parsed.reasoning_effort).toBeUndefined();
  } finally {
    await proxy2.kill();
    await raw2.close();
  }
});

test("Anthropic route is not stamped by reasoning_effort toggle", async () => {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "umans-coder",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 4096,
    }),
  }).catch(() => {});
  await sleep(150);
  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBe(4096);
  expect(parsed.reasoning_effort).toBeUndefined();
});
