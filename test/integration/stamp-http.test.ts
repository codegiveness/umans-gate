// Integration tests: stamp HTTP wiring via in-process proxy.
//
// Verifies that the proxy stamps request bodies end-to-end and the upstream
// receives the stamped wire bytes. Uses startInProcessProxy() (no subprocess)
// and startRawUpstream() (raw TCP capture of exact wire bytes).
//
// See ADR-0028 (docs/adr/0028-three-layer-test-pyramid.md).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startInProcessProxy } from "../helpers/in-process-proxy.js";
import { type RawUpstreamHandle, startRawUpstream } from "../helpers/raw-upstream.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let raw: RawUpstreamHandle;
let proxy: Awaited<ReturnType<typeof startInProcessProxy>>;

beforeAll(async () => {
  raw = await startRawUpstream();
  proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${raw.port}`,
    stampClaudeCodeEnabled: true,
    stampGlm52ThinkingEnabled: true,
    stampReasoningEffortEnabled: true,
    warmerEnabled: false,
    releaseCooldownMs: 0,
  });
});

afterAll(async () => {
  await proxy.kill();
  await raw.close();
});

async function sendAnthropic(bodyObj: Record<string, unknown>) {
  raw.getLastRequest(); // reset reference
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  }).catch(() => {});
  await sleep(150);
  return raw.getLastRequest();
}

async function sendOpenAi(bodyObj: Record<string, unknown>) {
  raw.getLastRequest();
  await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  }).catch(() => {});
  await sleep(150);
  return raw.getLastRequest();
}

describe("stamp HTTP wiring — Anthropic route", () => {
  test("stamps ttl, max_tokens, thinking, top_k, temperature on GLM body", async () => {
    const r = await sendAnthropic({
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    // TTL stamping
    expect(parsed.system[0].cache_control.ttl).toBe("1h");
    // max_tokens stamping (GLM = 131071)
    expect(parsed.max_tokens).toBe(131071);
    // thinking forcing to GLM Preserved Thinking (child toggle ON)
    expect(parsed.thinking).toEqual({
      type: "enabled",
      clear_thinking: false,
      budget_tokens: 32000,
    });
    // output_config stamping
    expect(parsed.output_config).toEqual({ effort: "max" });
    // top_k injection (GLM = 20, placed after model)
    expect(parsed.top_k).toBe(20);
    expect(parsed.model).toBe("umans-glm-5.2");
    const keys = Object.keys(parsed);
    expect(keys.indexOf("model")).toBeLessThan(keys.indexOf("top_k"));
    // temperature forcing to 1.0 (thinking enabled)
    expect(parsed.temperature).toBe(1.0);
  });

  test("preserves existing ttl and top_k (does not overwrite)", async () => {
    const r = await sendAnthropic({
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      top_k: 40,
      system: [
        {
          type: "text",
          text: "x",
          cache_control: { type: "ephemeral", ttl: "5m" },
        },
      ],
      messages: [],
    });
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    expect(parsed.system[0].cache_control.ttl).toBe("5m");
    expect(parsed.top_k).toBe(40);
  });
});

describe("stamp HTTP wiring — OpenAI route", () => {
  test("stamps reasoning_effort and top_k on OpenAI GLM body", async () => {
    const r = await sendOpenAi({
      model: "umans-glm-5.2",
      thinking: { type: "adaptive" },
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    // reasoning_effort injected from thinking (GLM = max)
    expect(parsed.reasoning_effort).toBe("max");
    // thinking stripped (OpenAI route)
    expect(parsed.thinking).toBeUndefined();
    // top_k injected (GLM = 20, after model)
    expect(parsed.top_k).toBe(20);
    expect(parsed.model).toBe("umans-glm-5.2");
    const keys = Object.keys(parsed);
    expect(keys.indexOf("model")).toBeLessThan(keys.indexOf("top_k"));
    // temperature forced to 1.0 (reasoning active)
    expect(parsed.temperature).toBe(1.0);
  });
});

describe("stamp HTTP wiring — toggle disabled", () => {
  let raw2: RawUpstreamHandle;
  let proxy2: Awaited<ReturnType<typeof startInProcessProxy>>;

  beforeAll(async () => {
    raw2 = await startRawUpstream();
    proxy2 = await startInProcessProxy({
      target: `http://127.0.0.1:${raw2.port}`,
      stampClaudeCodeEnabled: false,
      stampReasoningEffortEnabled: false,
      warmerEnabled: false,
      releaseCooldownMs: 0,
    });
  });

  afterAll(async () => {
    await proxy2.kill();
    await raw2.close();
  });

  test("stamping disabled → upstream receives unmodified body", async () => {
    raw2.getLastRequest();
    await fetch(`${proxy2.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "umans-glm-5.2",
        thinking: { type: "adaptive" },
        messages: [{ role: "user", content: "hi" }],
      }),
    }).catch(() => {});
    await sleep(150);
    const r = raw2.getLastRequest();
    expect(r).not.toBeNull();
    const parsed = JSON.parse(r!.body);
    expect(parsed.max_tokens).toBeUndefined();
    expect(parsed.top_k).toBeUndefined();
    expect(parsed.temperature).toBeUndefined();
    expect(parsed.output_config).toBeUndefined();
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });
});
