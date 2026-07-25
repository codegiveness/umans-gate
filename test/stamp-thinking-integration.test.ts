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

test("umans-coder without thinking: no body stamps", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBeUndefined();
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
  expect(parsed.top_k).toBeUndefined();
  expect(parsed.context_management).toBeUndefined();
  expect(parsed.temperature).toBeUndefined();
});

test("umans-flash without thinking: no body stamps", async () => {
  const body = JSON.stringify({
    model: "umans-flash",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBeUndefined();
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
});

test("umans-glm model without thinking: no body stamps", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBeUndefined();
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
  expect(parsed.top_k).toBeUndefined();
  expect(parsed.context_management).toBeUndefined();
});

test("non-glm non-thinking model: no body stamps", async () => {
  const body = JSON.stringify({
    model: "umans-other",
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.max_tokens).toBeUndefined();
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
});

test("non-adaptive thinking forced to Kimi Preserved Thinking (umans-coder, canDisable=false)", async () => {
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
  expect(parsed.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  expect(parsed.output_config).toEqual({ effort: "high" });
});

test("disabled thinking forced to Kimi Preserved Thinking (umans-coder, canDisable=false)", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    thinking: { type: "disabled" },
    max_tokens: 4096,
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  // output_config stamped (thinking is now enabled)
  expect(parsed.output_config).toEqual({ effort: "high" });
  // temperature forced (thinking is now enabled)
  expect(parsed.temperature).toBe(1.0);
});

test("disabled thinking respected (umans-glm, canDisable=true)", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    thinking: { type: "disabled" },
    max_tokens: 4096,
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.thinking).toEqual({ type: "disabled" });
  expect(parsed.output_config).toBeUndefined();
  expect(parsed.temperature).toBeUndefined();
  expect(parsed.max_tokens).toBe(4096);
  expect(parsed.top_k).toBeUndefined();
  expect(parsed.context_management).toBeUndefined();
});

test("reasoning_effort stripped on anthropic route when claude code style enabled", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    reasoning_effort: "high",
    thinking: { type: "adaptive" },
    max_tokens: 4096,
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBeUndefined();
  expect(parsed.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  expect(parsed.max_tokens).toBe(32767);
});

test("reasoning_effort stripped even when no thinking present", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    reasoning_effort: "max",
    max_tokens: 50,
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBeUndefined();
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

test("claude code toggle without thinking: no body stamps", async () => {
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
    expect(parsed.max_tokens).toBeUndefined();
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
    expect(parsed.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
    expect(parsed.output_config).toEqual({ effort: "high" });
    expect(parsed.temperature).toBe(1.0);
  } finally {
    await proxy3.kill();
    await raw3.close();
  }
});
