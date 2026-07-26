import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type ProxyHandle, startProxy } from "./helpers/proxy";
import { type RawUpstreamHandle, startRawUpstream } from "./helpers/raw-upstream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendStamped(
  proxy: ProxyHandle,
  raw: RawUpstreamHandle,
  model: string,
  thinking?: unknown,
): Promise<{
  max_tokens?: number;
  thinking?: unknown;
  output_config?: unknown;
  clear_thinking?: boolean;
}> {
  raw.getLastRequest();
  const body: Record<string, unknown> = { model, messages: [{ role: "user", content: "hi" }] };
  if (thinking !== undefined) body.thinking = thinking;
  await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => {});
  await sleep(150);
  const r = raw.getLastRequest();
  expect(r).not.toBeNull();
  return JSON.parse(r!.body);
}

describe("GLM 5.2 Preserved Thinking toggle (ADR-0019)", () => {
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

  test("GLM 5.2 model with child ON stamps clear_thinking: false", async () => {
    const parsed = await sendStamped(proxy, raw, "umans-glm-5.2", { type: "adaptive" });
    expect(parsed.max_tokens).toBe(131071);
    expect(parsed.thinking).toEqual({
      type: "enabled",
      clear_thinking: false,
      budget_tokens: 32000,
    });
    expect(parsed.output_config).toEqual({ effort: "max" });
  });

  test("GLM 5.1 model with child ON falls back to adaptive (version mismatch)", async () => {
    const parsed = await sendStamped(proxy, raw, "umans-glm-5.1", { type: "adaptive" });
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });

  test("umans-coder with child ON falls back to adaptive (no version match)", async () => {
    const parsed = await sendStamped(proxy, raw, "umans-coder", { type: "adaptive" });
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });

  test("disabled thinking forced to GLM shape (canDisable=true but parent override wins)", async () => {
    const parsed = await sendStamped(proxy, raw, "umans-glm-5.2", { type: "disabled" });
    // GLM canDisableThinking=true per overlay, so disabled is respected → no stamp.
    // But max_tokens stamps only when thinking enabled, so absent here.
    expect(parsed.thinking).toEqual({ type: "disabled" });
    expect(parsed.max_tokens).toBeUndefined();
  });
});

describe("GLM 5.2 toggle OFF (default) — adaptive fallback", () => {
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

  test("GLM 5.2 model with child OFF falls back to adaptive", async () => {
    const parsed = await sendStamped(proxy, raw, "umans-glm-5.2", { type: "adaptive" });
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });

  test("umans-coder with child OFF falls back to adaptive", async () => {
    const parsed = await sendStamped(proxy, raw, "umans-coder", { type: "adaptive" });
    expect(parsed.thinking).toEqual({ type: "adaptive" });
  });
});

describe("parent stamp_claude_code_enabled OFF — no stamping", () => {
  let raw: RawUpstreamHandle;
  let proxy: ProxyHandle;

  beforeAll(async () => {
    raw = await startRawUpstream();
    proxy = await startProxy({
      TARGET: `http://127.0.0.1:${raw.port}`,
      STAMP_CLAUDE_CODE_ENABLED: "false",
      STAMP_GLM_5_2_THINKING_ENABLED: "true",
    });
  });

  afterAll(async () => {
    await proxy.kill();
    await raw.close();
  });

  test("GLM 5.2 model with parent OFF has no stamps at all", async () => {
    const parsed = await sendStamped(proxy, raw, "umans-glm-5.2", { type: "adaptive" });
    expect(parsed.max_tokens).toBeUndefined();
    expect(parsed.thinking).toEqual({ type: "adaptive" });
    expect(parsed.output_config).toBeUndefined();
  });
});
