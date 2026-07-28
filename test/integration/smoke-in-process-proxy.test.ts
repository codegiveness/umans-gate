// Smoke test: verifies the in-process proxy harness boots, serves real HTTP,
// handles streaming SSE, and cleans up on kill().
//
// This is the proof-of-concept for the three-layer test pyramid (ADR-0028).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { startInProcessProxy } from "../helpers/in-process-proxy";
import { startMockLlmUpstream } from "../helpers/mock-llm-upstream";

let upstream: ReturnType<typeof startMockLlmUpstream>;
let proxy: Awaited<ReturnType<typeof startInProcessProxy>>;

beforeAll(async () => {
  upstream = startMockLlmUpstream();
  proxy = await startInProcessProxy({
    target: `http://127.0.0.1:${upstream.port}`,
    stampClaudeCodeEnabled: false,
    warmerEnabled: false,
    releaseCooldownMs: 0,
  });
});

afterAll(async () => {
  await proxy.kill();
  await upstream.close();
});

describe("in-process proxy smoke test", () => {
  test("health endpoint returns 200", async () => {
    const res = await fetch(`${proxy.baseUrl}/health`);
    expect(res.status).toBe(200);
  });

  test("streaming Anthropic request returns SSE response", async () => {
    const reqBody = {
      model: "umans-glm-5.2",
      max_tokens: 50,
      stream: true,
      messages: [{ role: "user", content: "Hello in-process smoke test" }],
    };

    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const body = await res.text();
    expect(body).toContain("event: message_start");
    expect(body).toContain("event: content_block_delta");
    expect(body).toContain("event: message_delta");
    expect(body).toContain("event: message_stop");
  });

  test("non-streaming Anthropic request returns JSON", async () => {
    const reqBody = {
      model: "umans-glm-5.2",
      max_tokens: 50,
      stream: false,
      messages: [{ role: "user", content: "Non-streaming smoke test" }],
    };

    const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(reqBody),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");

    const json = (await res.json()) as { usage?: { input_tokens?: number } };
    expect(json.usage).toBeDefined();
    expect(json.usage!.input_tokens).toBeGreaterThan(0);
  });

  test("internal state is accessible (db, gate)", () => {
    expect(proxy.db).toBeDefined();
    expect(proxy.gate).toBeDefined();
    expect(proxy.models).toBeDefined();
    expect(proxy.ws).toBeDefined();
    expect(proxy.config).toBeDefined();
    expect(proxy.config.target).toBe(`http://127.0.0.1:${upstream.port}`);
  });

  test("kill() can be called without error", async () => {
    // Verify kill() works — tested in afterAll but we also test it here
    // to make the assertion explicit. We create a second proxy to kill.
    const upstream2 = startMockLlmUpstream();
    const proxy2 = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream2.port}`,
      warmerEnabled: false,
      releaseCooldownMs: 0,
    });
    await proxy2.kill();
    await upstream2.close();
    // If we get here without throwing, kill() works.
    expect(true).toBe(true);
  });
});
