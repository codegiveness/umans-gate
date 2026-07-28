// Integration tests: intent-aware vision pipeline (decompose/craft/triage/fallback).
// Uses direct VisionHandoff + routing mock server (no proxy needed, but
// integration-tier since it exercises the real decomposition + crafting + vision
// pipeline end-to-end).
//
// Migrated from:
//   test/intent-aware-vision.test.ts (v2 base + v3 hard-constraints)
//   test/vision-decompose.test.ts integration block (per-image sub-questions)
//   test/vision-craft.test.ts integration block (crafted question routing)

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";
import { ConcurrencyGate, GateError } from "../../src/limiter/index.js";
import { DescriptionCache } from "../../src/vision/cache.js";
import type { VisionConfig } from "../../src/vision/handoff.js";
import { VisionHandoff } from "../../src/vision/handoff.js";
import { PersistentDescriptionStore } from "../../src/vision/persistent-cache.js";
import { wrapDescription } from "../../src/vision/wrapper.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const BLUE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
const GREEN_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC";

const WRAPPED_PREFIX =
  "[Image content — analyzed by vision module, shown as text because the active model cannot see images:]";

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeTmpDbPath(): string {
  return join(tmpdir(), `vision-intent-ip-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeConfig(overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    strategy: "always",
    target: "http://127.0.0.1:1",
    model: "umans-flash",
    prompt: "Describe this image.",
    promptVersion: 1,
    maxImages: 10,
    maxDescriptionTokens: 4096,
    reasoningEffort: null,
    timeoutMs: 0,
    cacheSize: 100,
    cacheTtlMs: 604_800_000,
    cacheMaxRows: 100,
    persistentCache: false,
    apiKey: null,
    forceInterceptCapable: false,
    concurrency: 1,
    maxDimension: 2048,
    jpegQuality: 92,
    imageFormat: "png",
    imageDetail: "auto",
    visionWeight: 1,
    backgroundVision: false,
    ...overrides,
  };
}

function makeGate(
  overrides: Partial<{
    hardCap: number;
    softLimit: number;
    maxQueueDepth: number;
    queueTimeoutMs: number;
  }> = {},
): ConcurrencyGate {
  return new ConcurrencyGate({
    hardCap: overrides.hardCap ?? 4,
    softLimit: overrides.softLimit ?? 4,
    releaseCooldownMs: 0,
    breakerThreshold: 100,
    breakerWindowMs: 5000,
    breakerCooldownMs: 1000,
    maxQueueDepth: overrides.maxQueueDepth ?? 256,
    queueTimeoutMs: overrides.queueTimeoutMs ?? 30000,
    intentions: { main: 1, vision: 1 },
  });
}

interface MockVisionHandle {
  port: number;
  getCallCount(): number;
  getRequest(i: number): unknown;
  close(): Promise<void>;
}

function startMockVision(description: string): MockVisionHandle {
  let callCount = 0;
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      requests.push(body);
      callCount++;
      return Response.json({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "umans-flash",
        choices: [
          { index: 0, message: { role: "assistant", content: description }, finish_reason: "stop" },
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

interface RoutingMockHandle {
  port: number;
  getAllRequests(): unknown[];
  getVisionRequests(): unknown[];
  getDecomposeRequests(): unknown[];
  getCraftRequests(): unknown[];
  close(): Promise<void>;
}

function startRoutingMock(opts: {
  decomposeResponse?: string[] | null;
  craftResponse?: string | null;
  visionDescription?: string;
  failAllVision?: boolean;
}): RoutingMockHandle {
  const allRequests: unknown[] = [];
  const visionReqs: unknown[] = [];
  const decomposeReqs: unknown[] = [];
  const craftReqs: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      allRequests.push(body);
      const messages = (body as { messages?: Array<{ role: string; content: unknown }> }).messages;
      const sysContent = typeof messages?.[0]?.content === "string" ? messages[0].content : "";

      if (sysContent.includes("decompose a multi-image")) {
        decomposeReqs.push(body);
        if (opts.decomposeResponse === null) {
          return Response.json(
            { choices: [{ message: { content: "not valid json" } }] },
            { status: 500 },
          );
        }
        const resp = opts.decomposeResponse ?? [
          "Does this image contain red? Describe if present.",
          "Does this image contain green? Describe if present.",
        ];
        return Response.json({
          choices: [{ message: { content: JSON.stringify(resp) } }],
        });
      }
      if (sysContent.includes("You reformulate user questions")) {
        craftReqs.push(body);
        if (opts.craftResponse === null) {
          return Response.json({ error: "upstream" }, { status: 500 });
        }
        const crafted =
          opts.craftResponse ??
          "Does this image show a technique or pattern? Describe what technique is visible.";
        return Response.json({ choices: [{ message: { content: crafted } }] });
      }
      visionReqs.push(body);
      if (opts.failAllVision) {
        return new Response("upstream error", { status: 500 });
      }
      return Response.json({
        id: "chatcmpl-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "umans-flash",
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: opts.visionDescription ?? "A pixel.",
            },
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
    getAllRequests: () => allRequests,
    getVisionRequests: () => visionReqs,
    getDecomposeRequests: () => decomposeReqs,
    getCraftRequests: () => craftReqs,
    close: () =>
      new Promise<void>((res) => {
        server.stop(true);
        setTimeout(res, 150);
      }),
  };
}

function makeOpenAiBody(text: string, ...imagesB64: string[]): unknown {
  return {
    model: "umans-glm-5.2",
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          ...imagesB64.map((data) => ({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${data}` },
          })),
        ],
      },
    ],
  };
}

function makeAnthropicBody(text: string, ...imagesB64: string[]): unknown {
  return {
    model: "umans-glm-5.2",
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [
          ...imagesB64.map((data) => ({
            type: "image",
            source: { type: "base64", media_type: "image/png", data },
          })),
          { type: "text", text },
        ],
      },
    ],
  };
}

function makeAnthropicBodyWithSystem(
  systemPrompt: string,
  text: string,
  imageB64: string,
): unknown {
  return {
    model: "umans-glm-5.2",
    max_tokens: 50,
    system: systemPrompt,
    messages: [
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: imageB64 } },
          { type: "text", text },
        ],
      },
    ],
  };
}

function makeAnthropicToolResultBody(text: string, imageB64: string): unknown {
  return {
    model: "umans-glm-5.2",
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text },
          {
            type: "tool_result",
            tool_use_id: "toolu_test",
            content: [
              {
                type: "image",
                source: { type: "base64", media_type: "image/png", data: imageB64 },
              },
            ],
          },
        ],
      },
    ],
  };
}

function extractReplacementText(result: { body: unknown }): string {
  const b = result.body as {
    messages: Array<{ content: Array<{ type: string; text?: string }> }>;
  };
  const parts = b.messages[0].content;
  const textBlocks = parts.filter((p) => p.type === "text");
  return textBlocks[textBlocks.length - 1]?.text ?? "";
}

function makeOpenAiBodyWithSystem(
  systemPrompt: string,
  text: string,
  ...imagesB64: string[]
): unknown {
  return {
    model: "umans-glm-5.2",
    max_tokens: 50,
    messages: [
      { role: "system", content: systemPrompt },
      {
        role: "user",
        content: [
          { type: "text", text },
          ...imagesB64.map((data) => ({
            type: "image_url",
            image_url: { url: `data:image/png;base64,${data}` },
          })),
        ],
      },
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// v2 base tests
// ─────────────────────────────────────────────────────────────────────────────

describe("Intent-aware vision integration — v2 base (in-process)", () => {
  let dbPath: string;
  let db: CaptureDB;
  let store: PersistentDescriptionStore;
  let cache: DescriptionCache;
  let gate: ConcurrencyGate;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = new CaptureDB({ dbPath, maxCaptures: 100 });
    store = new PersistentDescriptionStore(db, 60_000, 100);
    cache = new DescriptionCache(100, 60_000, store);
    gate = makeGate();
  });

  afterEach(() => {
    store.close();
    db.close();
    gate.shutdown();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("1. cache hit rate regression (Anthropic): image+Q1 miss → image+Q2 image-only HIT → image+Q1 context-tier HIT", async () => {
    const vision = startMockVision("A red pixel.");
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${vision.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const bodyQ1 = makeAnthropicBody("what color is the sky?", RED_PNG_B64);
      await handoff.processBody(bodyQ1, "anthropic");
      expect(vision.getCallCount()).toBe(1);

      const bodyQ2 = makeAnthropicBody("explain the layout", RED_PNG_B64);
      await handoff.processBody(bodyQ2, "anthropic");
      expect(vision.getCallCount()).toBe(1);

      await handoff.processBody(bodyQ1, "anthropic");
      expect(vision.getCallCount()).toBe(1);
    } finally {
      await vision.close();
    }
  });

  test("2. cache hit rate regression (OpenAI)", async () => {
    const vision = startMockVision("A red pixel.");
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${vision.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const bodyQ1 = makeOpenAiBody("what color is the sky?", RED_PNG_B64);
      await handoff.processBody(bodyQ1, "openai");
      expect(vision.getCallCount()).toBe(1);

      const bodyQ2 = makeOpenAiBody("explain the layout", RED_PNG_B64);
      await handoff.processBody(bodyQ2, "openai");
      expect(vision.getCallCount()).toBe(1);

      await handoff.processBody(bodyQ1, "openai");
      expect(vision.getCallCount()).toBe(1);
    } finally {
      await vision.close();
    }
  });

  test("3. multi-image cache + cross-route sharing", async () => {
    const vision = startMockVision("A pixel.");
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${vision.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const bodyMulti = makeAnthropicBody("describe both", RED_PNG_B64, BLUE_PNG_B64);
      await handoff.processBody(bodyMulti, "anthropic");
      expect(vision.getCallCount()).toBe(2);

      const bodySingle = makeOpenAiBody("what is this", RED_PNG_B64);
      await handoff.processBody(bodySingle, "openai");
      expect(vision.getCallCount()).toBe(2);
    } finally {
      await vision.close();
    }
  });

  test("4. triage: tool-result → generic", async () => {
    const vision = startMockVision("A pixel.");
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${vision.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeAnthropicToolResultBody("result", RED_PNG_B64);
      await handoff.processBody(body, "anthropic");
      expect(vision.getCallCount()).toBe(1);

      const req = vision.getRequest(0) as { messages: Array<{ content: unknown }> };
      // Generic has a single user message (no system), so messages[0] is the user.
      const userContent = req.messages[0].content as Array<{ type: string; text?: string }>;
      const textPart = userContent.find((p) => p.type === "text");
      // Generic uses the configured prompt directly, no "The user asked:" framing.
      expect(textPart?.text).toContain("Describe this image.");
    } finally {
      await vision.close();
    }
  });

  test("5. triage: multi-image → slotted (no references, no comparatives)", async () => {
    const vision = startMockVision("A pixel.");
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${vision.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeOpenAiBody("explain what you see", RED_PNG_B64, BLUE_PNG_B64);
      await handoff.processBody(body, "openai");
      expect(vision.getCallCount()).toBe(2);

      const req = vision.getRequest(0) as { messages: Array<{ content: unknown }> };
      const userContent = req.messages[1].content as Array<{ type: string; text?: string }>;
      const textPart = userContent.find((p) => p.type === "text");
      expect(textPart?.text).toContain("The user asked:");
    } finally {
      await vision.close();
    }
  });

  test("6. triage: multi-image with references → decomposed", async () => {
    const mock = startRoutingMock({});
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeOpenAiBody(
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      await handoff.processBody(body, "openai");

      expect(mock.getDecomposeRequests().length).toBe(1);
      expect(mock.getVisionRequests().length).toBe(2);
    } finally {
      await mock.close();
    }
  });

  test("7. triage: multi-image comparative → generic", async () => {
    const vision = startMockVision("A pixel.");
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${vision.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeOpenAiBody("compare these two images", RED_PNG_B64, BLUE_PNG_B64);
      await handoff.processBody(body, "openai");
      expect(vision.getCallCount()).toBe(2);

      const req = vision.getRequest(0) as { messages: Array<{ content: unknown }> };
      // Generic has a single user message (no system), so messages[0] is the user.
      const userContent = req.messages[0].content as Array<{ type: string; text?: string }>;
      const textPart = userContent.find((p) => p.type === "text");
      expect(textPart?.text).toContain("Describe this image.");
    } finally {
      await vision.close();
    }
  });

  test("8. triage: simple → slotted", async () => {
    const vision = startMockVision("A pixel.");
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${vision.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeOpenAiBody("a UI screenshot", RED_PNG_B64);
      await handoff.processBody(body, "openai");
      expect(vision.getCallCount()).toBe(1);

      const req = vision.getRequest(0) as { messages: Array<{ content: unknown }> };
      // Slotted has system + user, so messages[1] is the user.
      const userContent = req.messages[1].content as Array<{ type: string; text?: string }>;
      const textPart = userContent.find((p) => p.type === "text");
      expect(textPart?.text).toContain("The user asked:");
    } finally {
      await vision.close();
    }
  });

  test("9. triage: complex → crafted", async () => {
    const mock = startRoutingMock({});
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeOpenAiBody(
        "is this consistent with the pattern I described earlier?",
        RED_PNG_B64,
      );
      await handoff.processBody(body, "openai");

      expect(mock.getCraftRequests().length).toBe(1);
      expect(mock.getVisionRequests().length).toBe(1);
    } finally {
      await mock.close();
    }
  });

  test("10. Strategy D fallback to A on crafting failure", async () => {
    const mock = startRoutingMock({ craftResponse: null });
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeOpenAiBody(
        "is this consistent with the pattern I described earlier?",
        RED_PNG_B64,
      );
      await handoff.processBody(body, "openai");

      expect(mock.getCraftRequests().length).toBe(1);
      expect(mock.getVisionRequests().length).toBe(1);

      const visionReq = mock.getVisionRequests()[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userContent = visionReq.messages[1].content as Array<{ type: string; text?: string }>;
      const textPart = userContent.find((p) => p.type === "text");
      expect(textPart?.text).toContain("The user asked:");
    } finally {
      await mock.close();
    }
  });

  test("11. decompose fallback to A on failure", async () => {
    const mock = startRoutingMock({ decomposeResponse: null });
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeOpenAiBody(
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      await handoff.processBody(body, "openai");

      expect(mock.getDecomposeRequests().length).toBe(1);
      expect(mock.getVisionRequests().length).toBe(2);

      const visionReq1 = mock.getVisionRequests()[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userContent1 = visionReq1.messages[1].content as Array<{
        type: string;
        text?: string;
      }>;
      const textPart1 = userContent1.find((p) => p.type === "text");
      expect(textPart1?.text).toContain("The user asked:");
    } finally {
      await mock.close();
    }
  });

  test("12. decomposed: per-image sub-question reaches each vision call", async () => {
    const mock = startRoutingMock({});
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeOpenAiBody(
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      await handoff.processBody(body, "openai");

      expect(mock.getDecomposeRequests().length).toBe(1);
      expect(mock.getVisionRequests().length).toBe(2);

      const visionReq1 = mock.getVisionRequests()[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userContent1 = visionReq1.messages[1].content as Array<{
        type: string;
        text?: string;
      }>;
      const textPart1 = userContent1.find((p) => p.type === "text");
      expect(textPart1?.text).toContain("Does this image contain red?");
      expect(textPart1?.text).not.toContain("The user asked:");

      const visionReq2 = mock.getVisionRequests()[1] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userContent2 = visionReq2.messages[1].content as Array<{
        type: string;
        text?: string;
      }>;
      const textPart2 = userContent2.find((p) => p.type === "text");
      expect(textPart2?.text).toContain("Does this image contain green?");
      expect(textPart2?.text).not.toContain("The user asked:");
    } finally {
      await mock.close();
    }
  });

  test("13. positional labels in replacement text ([Image 1:, [Image 2:)", async () => {
    const mock = startRoutingMock({});
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeOpenAiBody(
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      const result = await handoff.processBody(body, "openai");
      const mutated = result.body as {
        messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      };
      const parts = mutated.messages[0].content;
      const textBlocks = parts.filter((p) => p.type === "text");
      expect(textBlocks.length).toBe(3);
      const labeled = textBlocks.filter((t) => t.text?.includes("[Image "));
      expect(labeled.length).toBe(2);
      expect(labeled[0]?.text).toContain("[Image 1:\n");
      expect(labeled[0]?.text).toContain(WRAPPED_PREFIX);
      expect(labeled[1]?.text).toContain("[Image 2:\n");
      expect(labeled[1]?.text).toContain(WRAPPED_PREFIX);
    } finally {
      await mock.close();
    }
  });

  test("14. crafted question reaches vision (not raw user text)", async () => {
    const crafted =
      "Does this image show a technique or pattern? Describe what technique is visible.";
    const mock = startRoutingMock({ craftResponse: crafted });
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeOpenAiBody(
        "is this consistent with the pattern I described earlier?",
        RED_PNG_B64,
      );
      await handoff.processBody(body, "openai");

      expect(mock.getCraftRequests().length).toBe(1);
      expect(mock.getVisionRequests().length).toBe(1);

      const visionReq = mock.getVisionRequests()[0] as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userContent = visionReq.messages[1].content as Array<{
        type: string;
        text?: string;
      }>;
      const textPart = userContent.find((p) => p.type === "text");
      expect(textPart?.text).toBe(crafted);
      expect(textPart?.text).not.toContain("The user asked:");
      expect(textPart?.text).not.toContain("consistent with the pattern");
    } finally {
      await mock.close();
    }
  });

  test("15. same complex question twice → context-tier HIT on second (0 vision on second)", async () => {
    const mock = startRoutingMock({});
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const question = "is this consistent with the pattern I described earlier?";
      const body1 = makeOpenAiBody(question, RED_PNG_B64);
      await handoff.processBody(body1, "openai");
      const callsAfterTurn1 = mock.getAllRequests().length;
      expect(callsAfterTurn1).toBe(2);

      const body2 = makeOpenAiBody(question, RED_PNG_B64);
      await handoff.processBody(body2, "openai");
      expect(mock.getAllRequests().length).toBe(callsAfterTurn1);
    } finally {
      await mock.close();
    }
  });

  test("16. crafting cache: same adjacentText + originalSystemPrompt → LLM called once", async () => {
    let craftCallCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        const sysContent =
          typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : "";
        if (sysContent.includes("You reformulate user questions")) {
          craftCallCount++;
          return Response.json({
            choices: [
              { message: { content: "Does this image show a pattern? Describe if present." } },
            ],
          });
        }
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A pattern." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${server.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);
      const question = "is this consistent with the pattern I described earlier?";
      const body1 = makeOpenAiBody(question, RED_PNG_B64);
      await handoff.processBody(body1, "openai");
      expect(craftCallCount).toBe(1);

      const body2 = makeOpenAiBody(question, BLUE_PNG_B64);
      await handoff.processBody(body2, "openai");
      expect(craftCallCount).toBe(1);
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("17. foreground mode (catalog strategy): rewrite on miss, cache hit on next call", async () => {
    const vision = startMockVision("A red pixel.");
    try {
      const config = makeConfig({
        target: `http://127.0.0.1:${vision.port}`,
        backgroundVision: true,
      });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body1 = makeOpenAiBody("what color is the sky?", RED_PNG_B64);
      const r1 = await handoff.processBodyCacheOnly(body1, "openai");
      expect(r1.changed).toBe(true);
      expect(vision.getCallCount()).toBe(1);

      const body2 = makeOpenAiBody("what color is the sky?", RED_PNG_B64);
      const r2 = await handoff.processBodyCacheOnly(body2, "openai");
      expect(r2.changed).toBe(true);
      const mutated = r2.body as {
        messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      };
      const textBlocks = mutated.messages[0].content.filter((p) => p.type === "text");
      const replacement = textBlocks[textBlocks.length - 1]?.text ?? "";
      expect(replacement).toContain(WRAPPED_PREFIX);
      expect(replacement).toContain("A red pixel.");
      expect(vision.getCallCount()).toBe(1);
    } finally {
      await vision.close();
    }
  });

  test("18. wrapDescription invariant: byte-identical for identical inputs", () => {
    const desc = "A red pixel.";
    const a = wrapDescription(desc);
    const b = wrapDescription(desc);
    const c = wrapDescription(desc);
    expect(a).toBe(b);
    expect(b).toBe(c);
    expect(a).toBe(`${WRAPPED_PREFIX}\n${desc}`);
    expect(wrapDescription("different")).not.toBe(a);
    expect(a).not.toMatch(/\[Image \d+:/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// v3 hard-constraint tests (Amendment A8)
// ─────────────────────────────────────────────────────────────────────────────

describe("Intent-aware vision integration — v3 hard-constraints (in-process)", () => {
  let dbPath: string;
  let db: CaptureDB;
  let store: PersistentDescriptionStore;
  let cache: DescriptionCache;
  let gate: ConcurrencyGate;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = new CaptureDB({ dbPath, maxCaptures: 100 });
    store = new PersistentDescriptionStore(db, 60_000, 100);
    cache = new DescriptionCache(100, 60_000, store);
    gate = makeGate();
  });

  afterEach(() => {
    store.close();
    db.close();
    gate.shutdown();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("19. system-prompt threading: [Original conversation intent: ...]", async () => {
    const vision = startMockVision("A red pixel.");
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${vision.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const body = makeAnthropicBodyWithSystem(
        "You are a color analysis expert",
        "what color is the sky?",
        RED_PNG_B64,
      );
      await handoff.processBody(body, "anthropic");

      expect(vision.getCallCount()).toBe(1);
      const req = vision.getRequest(0) as Record<string, unknown>;
      const messages = req.messages as Array<{ role: string; content: string }>;
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]?.content).toContain(
        "[Original conversation intent: You are a color analysis expert]",
      );
      expect(messages[0]?.content).toContain("Describe this image.");
    } finally {
      await vision.close();
    }
  });

  test("20. gate-over-cap invariant: 8 concurrent decomposition requests, peak ≤ 4", async () => {
    const lowGate = makeGate({
      hardCap: 4,
      softLimit: 4,
      maxQueueDepth: 256,
      queueTimeoutMs: 5000,
    });

    let activeVisionCalls = 0;
    let peakActive = 0;
    const mock = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        const sysContent =
          typeof body.messages?.[0]?.content === "string" ? body.messages[0].content : "";
        if (sysContent.includes("decompose a multi-image")) {
          activeVisionCalls++;
          peakActive = Math.max(peakActive, activeVisionCalls);
          await sleep(30);
          activeVisionCalls--;
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    "Does this image contain red? Describe if present.",
                    "Does this image contain green? Describe if present.",
                  ]),
                },
              },
            ],
          });
        }
        activeVisionCalls++;
        peakActive = Math.max(peakActive, activeVisionCalls);
        await sleep(30);
        activeVisionCalls--;
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A pixel." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, lowGate, db);

      const bodies = Array.from({ length: 8 }, (_, i) => {
        const imgB = i % 2 === 0 ? BLUE_PNG_B64 : GREEN_PNG_B64;
        return makeOpenAiBody("see red on image A and green on image B", RED_PNG_B64, imgB);
      });

      const samples: number[] = [];
      const sampler = setInterval(() => {
        samples.push(lowGate.getIntentionActive("vision"));
      }, 10);

      const results = await Promise.allSettled(bodies.map((b) => handoff.processBody(b, "openai")));
      clearInterval(sampler);

      for (const r of results) {
        expect(r.status).toBe("fulfilled");
      }
      for (const s of samples) {
        expect(s).toBeLessThanOrEqual(4);
      }
      expect(peakActive).toBeLessThanOrEqual(4);
    } finally {
      mock.stop(true);
      await sleep(100);
    }
  });

  test("21. cache-hit-100%-after-first-sight + concurrent-failure dedup", async () => {
    let visionCallCount = 0;
    const mock = Bun.serve({
      port: 0,
      async fetch() {
        visionCallCount++;
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A red pixel." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);

      const bodyQ1A = makeAnthropicBody("what color is the sky?", RED_PNG_B64);
      const r1 = await handoff.processBody(bodyQ1A, "anthropic");
      expect(visionCallCount).toBe(1);
      expect(r1.stats.cacheMisses).toBe(1);
      expect(r1.stats.visionCalls).toBe(1);

      const bodyQ2A = makeAnthropicBody("explain the layout", RED_PNG_B64);
      const r2 = await handoff.processBody(bodyQ2A, "anthropic");
      expect(visionCallCount).toBe(1);
      expect(r2.stats.cacheHits).toBe(1);
      expect(r2.stats.visionCalls).toBe(0);

      const r3 = await handoff.processBody(bodyQ1A, "anthropic");
      expect(visionCallCount).toBe(1);
      expect(r3.stats.cacheHits).toBe(1);

      const bodyQ3O = makeOpenAiBody("what shape is this?", RED_PNG_B64);
      const r4 = await handoff.processBody(bodyQ3O, "openai");
      expect(visionCallCount).toBe(1);
      expect(r4.stats.cacheHits).toBe(1);
    } finally {
      mock.stop(true);
      await sleep(100);
    }

    let failVisionCallCount = 0;
    const failMock = Bun.serve({
      port: 0,
      async fetch() {
        failVisionCallCount++;
        return new Response("upstream error", { status: 500 });
      },
    });
    try {
      const config2 = makeConfig({ target: `http://127.0.0.1:${failMock.port}` });
      const handoff2 = new VisionHandoff(config2, cache, null, gate, db);

      const bodyYQ1 = makeOpenAiBody("what color is the sky?", BLUE_PNG_B64);
      const bodyYQ2 = makeOpenAiBody("explain the layout", BLUE_PNG_B64);
      const [r1, r2] = await Promise.all([
        handoff2.processBody(bodyYQ1, "openai"),
        handoff2.processBody(bodyYQ2, "openai"),
      ]);

      expect(failVisionCallCount).toBe(1);

      const desc1 = extractReplacementText(r1);
      const desc2 = extractReplacementText(r2);
      expect(desc1).toContain("[Image analysis failed:");
      expect(desc2).toContain("[Image analysis failed:");

      const bodyYQ3 = makeOpenAiBody("what shape is this?", BLUE_PNG_B64);
      const r3 = await handoff2.processBody(bodyYQ3, "openai");
      expect(failVisionCallCount).toBe(2);
      const desc3 = extractReplacementText(r3);
      expect(desc3).toContain("[Image analysis failed:");
    } finally {
      failMock.stop(true);
      await sleep(100);
    }
  });

  test("22. gate-acquisition GateError → slotted fallback, no exception", async () => {
    const tinyGate = new ConcurrencyGate({
      hardCap: 1,
      softLimit: 1,
      releaseCooldownMs: 0,
      breakerThreshold: 100,
      breakerWindowMs: 5000,
      breakerCooldownMs: 1000,
      maxQueueDepth: 0,
      queueTimeoutMs: 10,
      intentions: { main: 1, vision: 1 },
    });

    const mock = startRoutingMock({});
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${mock.port}` });
      const handoff = new VisionHandoff(config, cache, null, tinyGate, db);

      const occupier = await tinyGate.acquire({ intention: "vision", weight: 1 });

      try {
        const decomposeBody = makeOpenAiBody(
          "see red on image A and green on image B",
          RED_PNG_B64,
          BLUE_PNG_B64,
        );
        const r1 = await handoff.processBody(decomposeBody, "openai");
        expect(r1.changed).toBe(true);
        expect(mock.getDecomposeRequests().length).toBe(0);

        const craftBody = makeOpenAiBody(
          "is this consistent with the pattern I described earlier?",
          RED_PNG_B64,
        );
        const r2 = await handoff.processBody(craftBody, "openai");
        expect(r2.changed).toBe(true);
        expect(mock.getCraftRequests().length).toBe(0);

        const mutated1 = r1.body as {
          messages: Array<{ content: Array<{ type: string; text?: string }> }>;
        };
        const textBlocks1 = mutated1.messages[0].content.filter((p) => p.type === "text");
        expect(textBlocks1.length).toBeGreaterThan(0);

        const mutated2 = r2.body as {
          messages: Array<{ content: Array<{ type: string; text?: string }> }>;
        };
        const textBlocks2 = mutated2.messages[0].content.filter((p) => p.type === "text");
        expect(textBlocks2.length).toBeGreaterThan(0);
      } finally {
        occupier.release();
      }
    } finally {
      await mock.close();
      tinyGate.shutdown();
    }

    const ge = new GateError("queue_full", "test");
    expect(ge.code).toBe("queue_full");
    expect(ge instanceof Error).toBe(true);
  });

  test("23. decomposed with originalSystemPrompt threads intent into decomposition + vision calls", async () => {
    const capturing: Array<{ body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        capturing.push({ body });
        const sys = body.messages?.[0];
        const sysContent = typeof sys?.content === "string" ? sys.content : "";
        if (sysContent.includes("decompose a multi-image")) {
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    "Does this image contain red? Describe if present.",
                    "Does this image contain green? Describe if present.",
                  ]),
                },
              },
            ],
          });
        }
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A pixel." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${server.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);
      const body = makeOpenAiBodyWithSystem(
        "You are a color expert",
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      await handoff.processBody(body, "openai");
      const decomposeReq = capturing[0].body as { messages: Array<{ content: string }> };
      expect(decomposeReq.messages[1].content).toContain(
        "Conversation intent: You are a color expert",
      );
      const visionReq1 = capturing[1].body as { messages: Array<{ content: string }> };
      expect(visionReq1.messages[0].content).toContain(
        "[Original conversation intent: You are a color expert]",
      );
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("24. image-only tier HIT: same 2 images + different question → 0 new calls", async () => {
    const capturing: Array<{ body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        capturing.push({ body });
        const sys = body.messages?.[0];
        const sysContent = typeof sys?.content === "string" ? sys.content : "";
        if (sysContent.includes("decompose a multi-image")) {
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    "Does this image contain red? Describe if present.",
                    "Does this image contain blue? Describe if present.",
                  ]),
                },
              },
            ],
          });
        }
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A pixel." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${server.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);
      const body1 = makeOpenAiBody(
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      await handoff.processBody(body1, "openai");
      const callsAfterTurn1 = capturing.length;
      expect(callsAfterTurn1).toBe(3);

      const body2 = makeOpenAiBody("explain what you see", RED_PNG_B64, BLUE_PNG_B64);
      await handoff.processBody(body2, "openai");
      expect(capturing.length).toBe(callsAfterTurn1);
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("25. decomposition cache: same batch key twice → LLM called once", async () => {
    const capturing: Array<{ body: unknown }> = [];
    let decomposeCallCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        capturing.push({ body });
        const sys = body.messages?.[0];
        const sysContent = typeof sys?.content === "string" ? sys.content : "";
        if (sysContent.includes("decompose a multi-image")) {
          decomposeCallCount++;
          return Response.json({
            choices: [
              {
                message: {
                  content: JSON.stringify([
                    "Does this image contain red? Describe if present.",
                    "Does this image contain green? Describe if present.",
                  ]),
                },
              },
            ],
          });
        }
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A pixel." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });
    try {
      const config = makeConfig({ target: `http://127.0.0.1:${server.port}` });
      const handoff = new VisionHandoff(config, cache, null, gate, db);
      const body1 = makeOpenAiBody(
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      await handoff.processBody(body1, "openai");
      expect(decomposeCallCount).toBe(1);

      const body2 = makeOpenAiBody(
        "see red on image A and green on image B",
        BLUE_PNG_B64,
        RED_PNG_B64,
      );
      await handoff.processBody(body2, "openai");
      expect(decomposeCallCount).toBe(1);
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });
});

void GREEN_PNG_B64;
