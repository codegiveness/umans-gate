import { afterAll, beforeAll, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "../helpers/proxy";
import { type RawUpstreamHandle, startRawUpstream } from "../helpers/raw-upstream";

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

test("OpenAI route injects reasoning_effort when thinking is enabled (umans-coder)", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 4096,
    thinking: { type: "enabled" },
    output_config: { effort: "low" },
    context_management: { edits: [] },
    temperature: 0.7,
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBe("high");
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
  expect(parsed.context_management).toBeUndefined();
  expect(parsed.temperature).toBe(1.0);
  expect(parsed.max_tokens).toBe(4096);
});

test("OpenAI route injects reasoning_effort=max when thinking is adaptive (umans-glm)", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "adaptive" },
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBe("max");
  expect(parsed.thinking).toBeUndefined();
});

test("OpenAI route does NOT inject when both reasoning_effort and thinking are absent", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    messages: [{ role: "user", content: "hi" }],
    max_tokens: 4096,
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBeUndefined();
  expect(parsed.max_tokens).toBe(4096);
});

test("OpenAI route respects disabled thinking (umans-glm, canDisable=true)", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBeUndefined();
  expect(parsed.thinking).toEqual({ type: "disabled" });
});

test("OpenAI route does not inject when thinking disabled and canDisable=false (umans-coder)", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    messages: [{ role: "user", content: "hi" }],
    thinking: { type: "disabled" },
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBeUndefined();
  expect(parsed.thinking).toEqual({ type: "disabled" });
});

test("OpenAI route forces existing reasoning_effort=low to high (umans-coder)", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "low",
    thinking: { type: "enabled" },
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBe("high");
  expect(parsed.thinking).toBeUndefined();
});

test("OpenAI route respects reasoning_effort=none when canDisable=true (umans-glm)", async () => {
  const body = JSON.stringify({
    model: "umans-glm-5.2",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "none",
    thinking: { type: "adaptive" },
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBe("none");
  expect(parsed.thinking).toEqual({ type: "adaptive" });
});

test("OpenAI route forces reasoning_effort=none to high when canDisable=false (umans-coder)", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "none",
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBe("high");
});

test("OpenAI route strips Anthropic fields and forces temperature when forcing reasoning_effort", async () => {
  const body = JSON.stringify({
    model: "umans-coder",
    messages: [{ role: "user", content: "hi" }],
    reasoning_effort: "low",
    thinking: { type: "adaptive" },
    output_config: { effort: "low" },
    context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] },
    temperature: 0.3,
    max_tokens: 4096,
  });
  const r = await sendOpenAi(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.reasoning_effort).toBe("high");
  expect(parsed.thinking).toBeUndefined();
  expect(parsed.output_config).toBeUndefined();
  expect(parsed.context_management).toBeUndefined();
  expect(parsed.temperature).toBe(1.0);
  expect(parsed.max_tokens).toBe(4096);
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
        reasoning_effort: "low",
        max_tokens: 4096,
      }),
    }).catch(() => {});
    await sleep(150);
    const r = raw2.getLastRequest();
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    expect(parsed.max_tokens).toBe(4096);
    expect(parsed.reasoning_effort).toBe("low");
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
