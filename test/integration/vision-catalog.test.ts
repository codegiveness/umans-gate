// Integration tests: vision catalog strategy via in-process proxy.
// Tests that catalog strategy uses the ModelsClient to look up vision
// capabilities and rewrites images only for non-vision models.
//
// Migrated from test/vision-handoff-integration.test.ts tests 12-14
// (subprocess → in-process). Requires a custom upstream serving /v1/models
// + /v1/models/info so ModelsClient learns model capabilities.

import { describe, expect, test } from "bun:test";
import { startInProcessProxy } from "../helpers/in-process-proxy";
import {
  handleAnthropic,
  handleOpenAi,
  type MockUpstreamHandle,
} from "../helpers/mock-llm-upstream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const WRAPPED_PREFIX =
  "[Image content — analyzed by vision module, shown as text because the active model cannot see images:]";

// ─── Mock vision upstream ────────────────────────────────────────────────────

interface MockVisionHandle {
  port: number;
  getCallCount(): number;
  getRequest(i: number): unknown;
  close(): Promise<void>;
}

function startMockVisionUpstream(description: string): MockVisionHandle {
  let callCount = 0;
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      requests.push(body);
      callCount++;
      return Response.json({
        id: "chatcmpl-vision-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "umans-flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: description },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    },
  });
  const port = server.port ?? 0;
  return {
    port,
    getCallCount: () => callCount,
    getRequest: (i: number) => requests[i],
    close: () =>
      new Promise<void>((res) => {
        server.stop(true);
        setTimeout(res, 150);
      }),
  };
}

// ─── Mock upstream with catalog (/v1/models + /v1/models/info) ───────────────

function startMockLlmUpstreamWithCatalog(port = 0): MockUpstreamHandle & {
  port: number;
} {
  let callCount = 0;
  const requests: unknown[] = [];
  const seenSystemPrompts = new Set<string>();

  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/v1/models") {
        return Response.json({
          data: [
            { id: "umans-glm-5.2", context_length: 200000, pricing: { input: 0, output: 0 } },
            { id: "umans-flash", context_length: 128000, pricing: { input: 0, output: 0 } },
          ],
        });
      }

      if (url.pathname === "/v1/models/info") {
        return Response.json({
          "umans-glm-5.2": { capabilities: { supports_vision: false } },
          "umans-flash": { capabilities: { supports_vision: true } },
        });
      }

      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      requests.push(body);
      callCount++;

      if (url.pathname === "/v1/messages") {
        return handleAnthropic(body, callCount, seenSystemPrompts);
      }
      if (url.pathname === "/v1/chat/completions") {
        return handleOpenAi(body, callCount);
      }
      return new Response("not found", { status: 404 });
    },
  });

  return {
    port: server.port ?? 0,
    getCallCount: () => callCount,
    getRequest: (i: number) => requests[i],
    reset: () => {
      callCount = 0;
      requests.length = 0;
      seenSystemPrompts.clear();
    },
    close: () =>
      new Promise<void>((res) => {
        server.stop();
        callCount = 0;
        requests.length = 0;
        setTimeout(res, 100);
      }),
  };
}

// ─── Type helpers ────────────────────────────────────────────────────────────

interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
}

interface ReceivedBody {
  model?: string;
  messages?: Array<{ role: string; content: string | ContentPart[] }>;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Vision catalog strategy (in-process)", () => {
  test("12. catalog + non-vision model → image rewritten before forward", async () => {
    const upstream = startMockLlmUpstreamWithCatalog();
    const vision = startMockVisionUpstream("A red pixel on white background.");
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "catalog",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: {
        visionModel: "umans-flash",
        visionIntentStrategy: "slotted",
        usageRefreshMs: 999999,
        modelsRefreshMs: 100,
      },
    });

    try {
      for (let i = 0; i < 50; i++) {
        const resp = await fetch(`${proxy.baseUrl}/dashboard/api/models`);
        if (resp.ok) {
          const data = (await resp.json()) as { entries?: unknown[] };
          if (data.entries && data.entries.length > 0) break;
        }
        await sleep(100);
      }

      upstream.reset();

      const sentBody = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${RED_PNG_B64}` },
              },
            ],
          },
        ],
      };
      const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sentBody),
      });
      expect(res.status).toBe(200);
      await res.text();
      await sleep(300);

      expect(vision.getCallCount()).toBe(1);
      expect(upstream.getCallCount()).toBe(1);
      const received = upstream.getRequest(0) as ReceivedBody;
      const parts = received.messages?.[0]?.content as ContentPart[];
      expect(parts[0].type).toBe("text");
      expect(parts[0].text).toBe("What is in this image?");
      expect(parts[1].type).toBe("text");
      expect(parts[1].text).toContain(WRAPPED_PREFIX);
      expect(parts[1].text).toContain("A red pixel on white background.");
      expect(parts.some((p) => p.type === "image_url")).toBe(false);
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  }, 30000);

  test("13. catalog + non-vision model → vision call persisted with intent", async () => {
    const upstream = startMockLlmUpstreamWithCatalog();
    const vision = startMockVisionUpstream("A red pixel.");
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "catalog",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: {
        visionModel: "umans-flash",
        visionIntentStrategy: "slotted",
        usageRefreshMs: 999999,
        modelsRefreshMs: 100,
      },
    });

    try {
      for (let i = 0; i < 50; i++) {
        const resp = await fetch(`${proxy.baseUrl}/dashboard/api/models`);
        if (resp.ok) {
          const data = (await resp.json()) as { entries?: unknown[] };
          if (data.entries && data.entries.length > 0) break;
        }
        await sleep(100);
      }

      const sentBody = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${RED_PNG_B64}` },
              },
            ],
          },
        ],
      };
      const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sentBody),
      });
      expect(res.status).toBe(200);
      await res.text();
      await sleep(300);

      const listResp = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=20`);
      expect(listResp.ok).toBe(true);
      const list = (await listResp.json()) as Array<{ id: number; is_vision: boolean }>;
      const visionCapture = list.find((c) => c.is_vision);
      expect(visionCapture).toBeDefined();
      const detailResp = await fetch(
        `${proxy.baseUrl}/dashboard/api/captures/${visionCapture!.id}`,
      );
      expect(detailResp.ok).toBe(true);
      const detail = (await detailResp.json()) as { request_body?: string };
      const reqBody = detail.request_body;
      expect(reqBody).toBeTruthy();
      expect(reqBody).not.toBe("{}");
      const parsed = JSON.parse(reqBody as string) as {
        messages?: Array<{ role?: string; content?: unknown }>;
      };
      const userContent = parsed.messages?.find((m) => m.role === "user")?.content;
      expect(Array.isArray(userContent)).toBe(true);
      const textBlock = (userContent as Array<{ type?: string; text?: string }>).find(
        (p) => p.type === "text",
      );
      expect(textBlock?.text).toContain("The user asked:");
      expect(textBlock?.text).toContain("What is in this image?");
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  }, 30000);

  test("14. catalog + vision-capable model → image passthrough, no vision call", async () => {
    const upstream = startMockLlmUpstreamWithCatalog();
    const vision = startMockVisionUpstream("Should not be called.");
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "catalog",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: {
        visionModel: "umans-flash",
        usageRefreshMs: 999999,
        modelsRefreshMs: 100,
      },
    });

    try {
      for (let i = 0; i < 50; i++) {
        const resp = await fetch(`${proxy.baseUrl}/dashboard/api/models`);
        if (resp.ok) {
          const data = (await resp.json()) as { entries?: unknown[] };
          if (data.entries && data.entries.length > 0) break;
        }
        await sleep(100);
      }

      upstream.reset();

      const sentBody = {
        model: "umans-flash",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${RED_PNG_B64}` },
              },
            ],
          },
        ],
      };
      const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sentBody),
      });
      expect(res.status).toBe(200);
      await res.text();
      await sleep(200);

      expect(vision.getCallCount()).toBe(0);
      expect(upstream.getCallCount()).toBe(1);
      const received = upstream.getRequest(0) as ReceivedBody;
      const parts = received.messages?.[0]?.content as ContentPart[];
      expect(parts.some((p) => p.type === "image_url")).toBe(true);
      expect(parts.some((p) => p.type === "text" && p.text?.includes(WRAPPED_PREFIX))).toBe(false);
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  }, 30000);
});
