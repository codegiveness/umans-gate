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

async function send(body: string) {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  }).catch(() => {});
  await sleep(150);
  return raw.getLastRequest();
}

test("umans-coder without thinking: only max_tokens stamped", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBe(32767);
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
});

test("umans-flash without thinking: only max_tokens stamped", async () => {
  const body = JSON.stringify({
    model: "umans-flash",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBe(32767);
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
});

test("umans-glm model without thinking: only max_tokens stamped", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBe(131071);
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
});

test("non-glm non-thinking model: only max_tokens stamped", async () => {
  const body = JSON.stringify({
    model: "umans-other",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBe(32767);
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
});

test("existing thinking respected, max_tokens + output_config stamped", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    thinking: { type: "enabled", keep: "all", budget_tokens: 8000 },
    max_tokens: 4096,
    output_config: { effort: "low" },
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBe(32767);
  // thinking respected (not overwritten)
  expect(parsed.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 8000 });
  // output_config stamped (thinking is enabled)
  expect(parsed.output_config).toEqual({ effort: "high" });
});

test("OpenAI route is not stamped even for umans-coder", async () => {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "umans-coder", messages: [{ role: "user", content: "hi" }] }),
  }).catch(() => {});
  await sleep(150);
  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBeUndefined();
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
});

test("disabling all stamp toggles disables injection", async () => {
  const raw2 = await startRawUpstream();
  const proxy2 = await startProxy({
    TARGET: `http://127.0.0.1:${raw2.port}`,
    STAMP_CLAUDE_CODE_ENABLED: "false",
  });
  try {
    raw2.getLastRequest();
    await fetch(`${proxy2.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "umans-coder", messages: [{ role: "user", content: "hi" }] }),
    }).catch(() => {});
    await sleep(150);
    const r = raw2.getLastRequest();
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    expect(parsed.max_tokens).toBeUndefined();
    expect(parsed.thinking).toBeUndefined();
    expect(parsed.output_config).toBeUndefined();
  } finally {
    await proxy2.kill();
    await raw2.close();
  }
});

test("claude code toggle stamps max_tokens when thinking absent", async () => {
  const raw3 = await startRawUpstream();
  const proxy3 = await startProxy({
    TARGET: `http://127.0.0.1:${raw3.port}`,
    STAMP_CLAUDE_CODE_ENABLED: "true",
  });
  try {
    raw3.getLastRequest();
    await fetch(`${proxy3.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "umans-coder", messages: [{ role: "user", content: "hi" }] }),
    }).catch(() => {});
    await sleep(150);
    const r = raw3.getLastRequest();
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    expect(parsed.max_tokens).toBe(32767);
    expect(parsed.thinking).toBeUndefined();
    expect(parsed.output_config).toBeUndefined();
  } finally {
    await proxy3.kill();
    await raw3.close();
  }
});

test("claude code toggle with thinking present stamps max_tokens + output_config + temperature", async () => {
  const raw3 = await startRawUpstream();
  const proxy3 = await startProxy({
    TARGET: `http://127.0.0.1:${raw3.port}`,
    STAMP_CLAUDE_CODE_ENABLED: "true",
  });
  try {
    raw3.getLastRequest();
    await fetch(`${proxy3.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-coder",
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: "hi" }],
      }),
    }).catch(() => {});
    await sleep(150);
    const r = raw3.getLastRequest();
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    expect(parsed.max_tokens).toBe(32767);
    expect(parsed.thinking).toEqual({ type: "adaptive" });
    expect(parsed.output_config).toEqual({ effort: "high" });
    expect(parsed.temperature).toBe(1.0);
  } finally {
    await proxy3.kill();
    await raw3.close();
  }
});
