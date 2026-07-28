// Integration tests: vision handoff end-to-end through the in-process proxy.
// Uses startInProcessProxy() + mock upstreams (main LLM + vision) and verifies
// the full pipeline: detect → transcode → cache → vision call → wrap → replace
// image blocks → forward to upstream.
//
// Migrated from test/vision-handoff-integration.test.ts (subprocess → in-process).

import { describe, expect, test } from "bun:test";
import { startInProcessProxy } from "../helpers/in-process-proxy";
import { startMockLlmUpstream } from "../helpers/mock-llm-upstream";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1x1 red PNG (base64). */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Wrapped-description label prefix for a single image (from wrapper.ts). */
const WRAPPED_PREFIX =
  "[Image content — analyzed by vision module, shown as text because the active model cannot see images:]";

// ─── Mock vision upstream (fresh Bun.serve per call) ─────────────────────────

interface MockVisionHandle {
  port: number;
  getCallCount(): number;
  getRequest(i: number): unknown;
  close(): Promise<void>;
}

interface VisionMockOptions {
  description?: string;
  status?: number;
  delayMs?: number;
  reasoningMode?: boolean;
}

function startMockVisionUpstream(opts: VisionMockOptions = {}): MockVisionHandle {
  const description = opts.description ?? "A screenshot of a React error overlay.";
  const status = opts.status ?? 200;
  const delayMs = opts.delayMs ?? 0;
  const reasoningMode = opts.reasoningMode ?? false;

  let callCount = 0;
  const requests: unknown[] = [];

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      requests.push(body);
      callCount++;
      if (delayMs > 0) await Bun.sleep(delayMs);
      if (status !== 200) {
        return new Response(JSON.stringify({ error: "mock vision error" }), {
          status,
          headers: { "content-type": "application/json" },
        });
      }
      const message: { role: string; content: string | null; reasoning_content?: string } = {
        role: "assistant",
        content: reasoningMode ? null : description,
      };
      if (reasoningMode) message.reasoning_content = description;
      return Response.json({
        id: "chatcmpl-vision-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "umans-flash",
        choices: [{ index: 0, message, finish_reason: "stop" }],
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

// ─── Type helpers for inspecting upstream-received bodies ────────────────────

interface ContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  cache_control?: { type: string; ttl?: string };
}

interface ReceivedBody {
  model?: string;
  messages?: Array<{ role: string; content: string | ContentPart[] }>;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("Vision handoff integration (in-process)", () => {
  test("1. text-only request → no vision call (strategy=catalog)", async () => {
    const upstream = startMockLlmUpstream();
    const vision = startMockVisionUpstream();
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "catalog",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: { visionModel: "umans-flash", usageRefreshMs: 999999 },
    });

    try {
      await sleep(100);
      upstream.reset();

      const sentBody = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [{ role: "user", content: "Hello, no images here" }],
      };
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sentBody),
      });
      expect(res.status).toBe(200);
      await res.text();
      await sleep(150);

      expect(upstream.getCallCount()).toBe(1);
      const received = upstream.getRequest(0) as ReceivedBody;
      expect(received.messages).toEqual(sentBody.messages);
      expect(vision.getCallCount()).toBe(0);
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  });

  test("2. image request → vision call → description replaces image (strategy=always)", async () => {
    const upstream = startMockLlmUpstream();
    const vision = startMockVisionUpstream();
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "always",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: { visionModel: "umans-flash", usageRefreshMs: 999999 },
    });

    try {
      await sleep(100);
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
      await sleep(200);

      expect(vision.getCallCount()).toBe(1);
      expect(upstream.getCallCount()).toBe(1);
      const received = upstream.getRequest(0) as ReceivedBody;
      const content = received.messages?.[0]?.content;
      expect(Array.isArray(content)).toBe(true);
      const parts = content as ContentPart[];
      expect(parts[0].type).toBe("text");
      expect(parts[0].text).toBe("What is in this image?");
      expect(parts[1].type).toBe("text");
      expect(parts[1].text).toContain(WRAPPED_PREFIX);
      expect(parts[1].text).toContain("A screenshot of a React error overlay.");
      expect(parts.some((p) => p.type === "image_url")).toBe(false);
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  });

  test("3. repeated image → cache hit → no second vision call", async () => {
    const upstream = startMockLlmUpstream();
    const vision = startMockVisionUpstream();
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "always",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: { visionModel: "umans-flash", usageRefreshMs: 999999 },
    });

    try {
      await sleep(100);
      upstream.reset();

      const makeBody = () => ({
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this." },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${RED_PNG_B64}` },
              },
            ],
          },
        ],
      });

      const res1 = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeBody()),
      });
      expect(res1.status).toBe(200);
      await res1.text();
      await sleep(200);
      expect(vision.getCallCount()).toBe(1);

      const res2 = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(makeBody()),
      });
      expect(res2.status).toBe(200);
      await res2.text();
      await sleep(200);

      expect(vision.getCallCount()).toBe(1);
      expect(upstream.getCallCount()).toBe(2);
      const r1 = upstream.getRequest(0) as ReceivedBody;
      const r2 = upstream.getRequest(1) as ReceivedBody;
      const c1 = ((r1.messages?.[0]?.content ?? []) as ContentPart[]).find(
        (p) => p.type === "text" && p.text?.includes(WRAPPED_PREFIX),
      );
      const c2 = ((r2.messages?.[0]?.content ?? []) as ContentPart[]).find(
        (p) => p.type === "text" && p.text?.includes(WRAPPED_PREFIX),
      );
      expect(c1).toBeDefined();
      expect(c2).toBeDefined();
      expect(c1?.text).toBe(c2?.text);
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  });

  test("4. vision error (HTTP 500) → fail-open placeholder", async () => {
    const upstream = startMockLlmUpstream();
    const vision = startMockVisionUpstream({ status: 500 });
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "always",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: { visionModel: "umans-flash", usageRefreshMs: 999999 },
    });

    try {
      await sleep(100);
      upstream.reset();

      const sentBody = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
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

      expect(vision.getCallCount()).toBe(1);
      expect(upstream.getCallCount()).toBe(1);
      const received = upstream.getRequest(0) as ReceivedBody;
      const parts = received.messages?.[0]?.content as ContentPart[];
      const placeholder = parts.find(
        (p) => p.type === "text" && p.text?.includes("[Image analysis failed:"),
      );
      expect(placeholder).toBeDefined();
      expect(placeholder?.text).toContain("vision model returned HTTP 500");
      expect(placeholder?.text).toContain("The active model cannot see this image.");
      expect(parts.some((p) => p.type === "image_url")).toBe(false);
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  }, 30000);

  test("5. unsupported format (garbage bytes) → transcode failure → placeholder", async () => {
    const upstream = startMockLlmUpstream();
    const vision = startMockVisionUpstream();
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "always",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: { visionModel: "umans-flash", usageRefreshMs: 999999 },
    });

    try {
      await sleep(100);
      upstream.reset();

      const sentBody = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "image_url",
                image_url: { url: "data:image/bmp;base64,AQIDBA==" },
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
      const placeholder = parts.find(
        (p) => p.type === "text" && p.text?.includes("[Image analysis failed:"),
      );
      expect(placeholder).toBeDefined();
      expect(placeholder?.text).toContain("transcode");
      expect(placeholder?.text).toContain("The active model cannot see this image.");
      expect(parts.some((p) => p.type === "image_url")).toBe(false);
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  });

  test("6. reasoning model (content:null, reasoning_content set) → empty → fail-open placeholder", async () => {
    const upstream = startMockLlmUpstream();
    const vision = startMockVisionUpstream({
      description: "A reasoning model described this image.",
      reasoningMode: true,
    });
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "always",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: { visionModel: "umans-flash", usageRefreshMs: 999999 },
    });

    try {
      await sleep(100);
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
      await sleep(200);

      expect(vision.getCallCount()).toBe(1);
      expect(upstream.getCallCount()).toBe(1);
      const received = upstream.getRequest(0) as ReceivedBody;
      const parts = received.messages?.[0]?.content as ContentPart[];
      const placeholder = parts.find(
        (p) => p.type === "text" && p.text?.includes("[Image analysis failed:"),
      );
      expect(placeholder).toBeDefined();
      expect(placeholder?.text).toContain("empty description");
      expect(placeholder?.text).toContain("The active model cannot see this image.");
      expect(parts.some((p) => p.type === "image_url")).toBe(false);
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  });

  test("7. same image sequential → cache hit on 2nd call", async () => {
    const upstream = startMockLlmUpstream();
    const vision = startMockVisionUpstream({ delayMs: 300 });
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "always",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: { visionModel: "umans-flash", visionConcurrency: 1, usageRefreshMs: 999999 },
    });

    try {
      await sleep(100);
      upstream.reset();

      const makeImageRequest = () => {
        const body = {
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
        return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      };

      const res1 = await makeImageRequest();
      expect(res1.status).toBe(200);
      await res1.text();
      await sleep(300);

      const res2 = await makeImageRequest();
      expect(res2.status).toBe(200);
      await res2.text();
      await sleep(200);

      expect(vision.getCallCount()).toBe(1);
      expect(upstream.getCallCount()).toBe(2);
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  });

  test("8. concurrent different images → vision calls serialized (no overlap)", async () => {
    const upstream = startMockLlmUpstream();
    const callIntervals: Array<{ start: number; end: number }> = [];
    let visionCallCount = 0;
    const visionServer = Bun.serve({
      port: 0,
      async fetch() {
        const start = Date.now();
        visionCallCount++;
        await Bun.sleep(200);
        callIntervals.push({ start, end: Date.now() });
        return Response.json({
          id: "chatcmpl-vision-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: `Description ${visionCallCount}` },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });
    const visionPort = visionServer.port ?? 0;

    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "always",
      visionTarget: `http://127.0.0.1:${visionPort}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      concurrencySoftLimit: 1,
      concurrencyHardCap: 1,
      useHardCap: true,
      configOverrides: { visionModel: "umans-flash", visionConcurrency: 1, usageRefreshMs: 999999 },
    });

    try {
      await sleep(100);
      upstream.reset();

      const images = [
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==",
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAD0lEQVR4nGNg+M+AQMRxAJ6jD/Flt2QIAAAAAElFTkSuQmCC",
        "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGNgYPiPhIjiAACOsw/xs6MvMwAAAABJRU5ErkJggg==",
      ];

      const makeRequest = (imgB64: string) => {
        const body = {
          model: "umans-glm-5.2",
          max_tokens: 50,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: "What is in this image?" },
                {
                  type: "image_url",
                  image_url: { url: `data:image/png;base64,${imgB64}` },
                },
              ],
            },
          ],
        };
        return fetch(`${proxy.baseUrl}/v1/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
      };

      const responses = await Promise.all(images.map(makeRequest));
      for (const res of responses) {
        expect(res.status).toBe(200);
        await res.text();
      }
      await sleep(200);

      expect(visionCallCount).toBe(3);
      expect(callIntervals.length).toBe(3);
      for (let i = 1; i < callIntervals.length; i++) {
        expect(callIntervals[i].start).toBeGreaterThanOrEqual(callIntervals[i - 1].end);
      }
    } finally {
      await proxy.kill();
      await upstream.close();
      visionServer.stop(true);
      await sleep(150);
    }
  });

  test("9. client disconnect during queued vision wait → abort propagates", async () => {
    const upstream = startMockLlmUpstream();
    let visionCallCount = 0;
    const visionServer = Bun.serve({
      port: 0,
      async fetch() {
        visionCallCount++;
        await Bun.sleep(500);
        return Response.json({
          id: "chatcmpl-vision-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "Description" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });
    const visionPort = visionServer.port ?? 0;

    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "always",
      visionTarget: `http://127.0.0.1:${visionPort}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      concurrencySoftLimit: 1,
      concurrencyHardCap: 1,
      useHardCap: true,
      configOverrides: { visionModel: "umans-flash", visionConcurrency: 1, usageRefreshMs: 999999 },
    });

    try {
      await sleep(100);
      upstream.reset();

      const imgB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

      const body1 = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is in this image?" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${imgB64}` } },
            ],
          },
        ],
      };
      const req1 = fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body1),
      }).catch((e) => {
        const code =
          (e as { code?: string })?.code ?? (e as { cause?: { code?: string } })?.cause?.code;
        if (code === "ECONNRESET") return null;
        throw e;
      });

      const firstCallDeadline = Date.now() + 5000;
      while (Date.now() < firstCallDeadline) {
        if (visionCallCount >= 1) break;
        await sleep(50);
      }
      expect(visionCallCount).toBe(1);

      const controller = new AbortController();
      const body2 = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Describe this" },
              {
                type: "image_url",
                image_url: {
                  url: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==",
                },
              },
            ],
          },
        ],
      };
      const req2 = fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body2),
        signal: controller.signal,
      }).catch((e) => {
        if (e instanceof DOMException && e.name === "AbortError") return null;
        throw e;
      });

      await sleep(100);
      controller.abort();

      const res1 = await req1;
      if (res1 !== null) {
        expect(res1.status).toBe(200);
        await res1.text();
      }

      const res2 = await req2;
      expect(res2).toBeNull();

      await sleep(300);
      expect(visionCallCount).toBe(1);
    } finally {
      await proxy.kill();
      await upstream.close();
      visionServer.stop(true);
      await sleep(150);
    }
  });

  test("10. reasoning_effort sent on 400 → single attempt, no fallback", async () => {
    const upstream = startMockLlmUpstream();

    let visionCallCount = 0;
    const visionRequests: unknown[] = [];
    const visionServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json().catch(() => ({}));
        visionRequests.push(body);
        visionCallCount++;
        return new Response(JSON.stringify({ error: "reasoning_effort not supported" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const visionPort = visionServer.port ?? 0;

    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      visionStrategy: "always",
      visionTarget: `http://127.0.0.1:${visionPort}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: {
        visionModel: "umans-flash",
        visionReasoningEffort: "high",
        usageRefreshMs: 999999,
      },
    });

    try {
      await sleep(100);
      upstream.reset();

      const sentBody = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${RED_PNG_B64}` } },
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

      expect(visionCallCount).toBe(1);

      const req1 = visionRequests[0] as Record<string, unknown>;
      expect(req1.reasoning_effort).toBe("high");
      expect(req1.max_tokens).toBeUndefined();
      expect(req1.max_completion_tokens).toBeUndefined();

      expect(upstream.getCallCount()).toBe(1);
      const received = upstream.getRequest(0) as ReceivedBody;
      const parts = received.messages?.[0]?.content as ContentPart[];
      const placeholder = parts.find(
        (p) => p.type === "text" && p.text?.includes("[Image analysis failed:"),
      );
      expect(placeholder).toBeDefined();
      expect(placeholder?.text).toContain("HTTP 400");
      expect(placeholder?.text).toContain("The active model cannot see this image.");
    } finally {
      await proxy.kill();
      await upstream.close();
      visionServer.stop(true);
      await sleep(150);
    }
  }, 30000);

  test("11. post-handoff cache_control stamping (§5b, Anthropic route)", async () => {
    const upstream = startMockLlmUpstream();
    const vision = startMockVisionUpstream({ description: "A red pixel." });
    const proxy = await startInProcessProxy({
      target: `http://127.0.0.1:${upstream.port}`,
      stampClaudeCodeEnabled: true,
      visionStrategy: "always",
      visionTarget: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
      umansApiKey: "test-key",
      warmerEnabled: false,
      configOverrides: { visionModel: "umans-flash", usageRefreshMs: 999999 },
    });

    try {
      await sleep(100);
      upstream.reset();

      const sentBody = {
        model: "umans-glm-5.2",
        max_tokens: 50,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: RED_PNG_B64,
                },
              },
            ],
          },
        ],
      };
      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(sentBody),
      });
      expect(res.status).toBe(200);
      await res.text();
      await sleep(200);

      expect(vision.getCallCount()).toBe(1);
      expect(upstream.getCallCount()).toBe(1);
      const received = upstream.getRequest(0) as ReceivedBody;
      const parts = received.messages?.[0]?.content as ContentPart[];

      const descBlock = parts.find((p) => p.type === "text" && p.text?.includes(WRAPPED_PREFIX));
      expect(descBlock).toBeDefined();
      expect(descBlock?.cache_control).toBeDefined();
      expect(descBlock?.cache_control?.type).toBe("ephemeral");
      expect(descBlock?.cache_control?.ttl).toBe("1h");
    } finally {
      await proxy.kill();
      await upstream.close();
      await vision.close();
    }
  });
});
