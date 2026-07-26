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
    STAMP_KIMI_K2_7_CODE_THINKING_ENABLED: "true",
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

test("umans-kimi-k2.7-code with adaptive thinking: forced to Kimi Preserved Thinking (keep: all)", async () => {
  const body = JSON.stringify({
    model: "umans-kimi-k2.7-code",
    thinking: { type: "adaptive" },
    max_tokens: 4096,
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  expect(parsed.max_tokens).toBe(32767);
  expect(parsed.output_config).toEqual({ effort: "high" });
  expect(parsed.temperature).toBe(1.0);
});

test("umans-kimi-k2.7-code with disabled thinking: forced to Kimi Preserved Thinking (canDisable=false)", async () => {
  const body = JSON.stringify({
    model: "umans-kimi-k2.7-code",
    thinking: { type: "disabled" },
    max_tokens: 4096,
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
  // max_tokens is gated on thinking being enabled BEFORE forcing; disabled input
  // means max_tokens is NOT stamped (stays 4096). output_config IS stamped (thinking
  // is now enabled after forcing).
  expect(parsed.max_tokens).toBe(4096);
  expect(parsed.output_config).toEqual({ effort: "high" });
  expect(parsed.temperature).toBe(1.0);
});

test("umans-kimi-k2.7-code-highspeed with adaptive thinking: matches and forces Kimi shape", async () => {
  const body = JSON.stringify({
    model: "umans-kimi-k2.7-code-highspeed",
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.thinking).toEqual({ type: "enabled", keep: "all", budget_tokens: 32000 });
});

test("umans-kimi-k2.6 with adaptive thinking: version mismatch falls back to adaptive", async () => {
  const body = JSON.stringify({
    model: "umans-kimi-k2.6",
    thinking: { type: "adaptive" },
    messages: [{ role: "user", content: "hi" }],
  });
  const r = await send(body);
  expect(r).not.toBeNull();
  const parsed = JSON.parse(r!.body);
  expect(parsed.thinking).toEqual({ type: "adaptive" });
});

test("reasoning_effort stripped on Kimi K2.7-Code (never stamped)", async () => {
  const body = JSON.stringify({
    model: "umans-kimi-k2.7-code",
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
});
