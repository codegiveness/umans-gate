// Integration tests for Task 7: Prism crafted question (Strategy D).
//
// Verifies:
//   - craftVisionQuestion success path (returns crafted string)
//   - craftVisionQuestion failure paths (HTTP error, timeout, malformed JSON) → null
//   - craftVisionQuestion GateError → null (slotted fallback)
//   - System prompt asks for neutral phrasing + includes the example (sycophancy defense)
//   - User prompt threads originalSystemPrompt + recentMessages
//   - End-to-end via VisionHandoff.processBody:
//     * Complex question → crafted question reaches the vision call (not raw user text)
//     * Crafting LLM timeout → fallback to Strategy A (slotted with "The user asked:")
//     * Same complex question twice → context-tier HIT on second call (0 vision calls)
//     * Crafting cache: same adjacentText + originalSystemPrompt twice → LLM called once
//
// Run: bun test test/vision-craft.test.ts

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../src/db.js";
import { ConcurrencyGate } from "../src/limiter/index.js";
import { DescriptionCache } from "../src/vision/cache.js";
import { type CraftConfig, craftVisionQuestion, craftingCacheKey } from "../src/vision/craft.js";
import { VisionHandoff } from "../src/vision/handoff.js";
import type { VisionConfig } from "../src/vision/handoff.js";
import { PersistentDescriptionStore } from "../src/vision/persistent-cache.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── test image data ──────────────────────────────────────────────────────────

/** 1x1 red PNG (base64). */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `vision-craft-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
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

function makeGate(): ConcurrencyGate {
  return new ConcurrencyGate({
    hardCap: 4,
    softLimit: 4,
    releaseCooldownMs: 0,
    breakerThreshold: 100,
    breakerWindowMs: 5000,
    breakerCooldownMs: 1000,
    maxQueueDepth: 256,
    queueTimeoutMs: 30000,
    intentions: { main: 1, vision: 1 },
  });
}

function makeCraftConfig(port: number, overrides: Partial<CraftConfig> = {}): CraftConfig {
  return {
    target: `http://127.0.0.1:${port}/v1/chat/completions`,
    model: "umans-flash",
    visionWeight: 1,
    apiKey: "test-key",
    ...overrides,
  };
}

interface MockLlmHandle {
  port: number;
  getCallCount(): number;
  getRequest(i: number): unknown;
  close(): Promise<void>;
}

/**
 * Mock LLM upstream that returns a canned response. The `responder` callback
 * lets each test decide what to return (success string, error, malformed JSON,
 * etc.) so we can exercise every failure path.
 */
function startMockCraftLlm(
  responder: () => {
    status?: number;
    body: unknown;
  },
): MockLlmHandle {
  let callCount = 0;
  const requests: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
      requests.push(body);
      callCount++;
      const { status = 200, body: respBody } = responder();
      if (typeof respBody === "string") {
        return new Response(respBody, { status, headers: { "content-type": "application/json" } });
      }
      return Response.json(respBody, { status });
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

// ── Unit tests: craftVisionQuestion ───────────────────────────────────────────

describe("Task 7 — craftVisionQuestion unit tests", () => {
  test("1. success: returns the crafted question string", async () => {
    const crafted =
      "Does this image show a technique or pattern? Describe what technique is visible.";
    const llm = startMockCraftLlm(() => ({
      body: { choices: [{ message: { content: crafted } }] },
    }));
    const gate = makeGate();
    try {
      const result = await craftVisionQuestion(
        fetch,
        makeCraftConfig(llm.port),
        gate,
        "is this the right way to do X?",
        [],
        undefined,
      );
      expect(result).toBe(crafted);
      expect(llm.getCallCount()).toBe(1);
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("2a. HTTP error → null (slotted fallback)", async () => {
    const llm = startMockCraftLlm(() => ({ status: 500, body: { error: "upstream" } }));
    const gate = makeGate();
    try {
      const result = await craftVisionQuestion(
        fetch,
        makeCraftConfig(llm.port),
        gate,
        "is this the right way to do X?",
        [],
      );
      expect(result).toBeNull();
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("2b. timeout → null (slotted fallback)", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await sleep(500);
        return Response.json({});
      },
    });
    const gate = makeGate();
    try {
      const result = await craftVisionQuestion(
        fetch,
        makeCraftConfig(server.port),
        gate,
        "is this the right way to do X?",
        [],
        undefined,
        undefined,
        50, // 50ms timeout — well under the 500ms server delay
      );
      expect(result).toBeNull();
    } finally {
      server.stop(true);
      gate.shutdown();
      await sleep(50);
    }
  });

  test("2c. malformed JSON body → null", async () => {
    const llm = startMockCraftLlm(() => ({
      body: { choices: [{ message: { content: null } }] },
    }));
    const gate = makeGate();
    try {
      const result = await craftVisionQuestion(
        fetch,
        makeCraftConfig(llm.port),
        gate,
        "is this the right way to do X?",
        [],
      );
      expect(result).toBeNull();
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("2d. empty content string → null", async () => {
    const llm = startMockCraftLlm(() => ({
      body: { choices: [{ message: { content: "" } }] },
    }));
    const gate = makeGate();
    try {
      const result = await craftVisionQuestion(
        fetch,
        makeCraftConfig(llm.port),
        gate,
        "is this the right way to do X?",
        [],
      );
      expect(result).toBeNull();
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("3. GateError (queue_full) → null (slotted fallback)", async () => {
    const llm = startMockCraftLlm(() => ({
      body: { choices: [{ message: { content: "crafted question" } }] },
    }));
    // Gate with queue depth 0 + tiny timeout → acquire rejects with queue_full.
    const gate = new ConcurrencyGate({
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
    // Occupy the only slot so the next acquire must queue (and fail).
    const occupying = await gate.acquire({ intention: "vision", weight: 1 });
    try {
      const result = await craftVisionQuestion(
        fetch,
        makeCraftConfig(llm.port),
        gate,
        "is this the right way to do X?",
        [],
      );
      expect(result).toBeNull();
      // LLM never called because gate rejected.
      expect(llm.getCallCount()).toBe(0);
    } finally {
      occupying.release();
      await llm.close();
      gate.shutdown();
    }
  });

  test("4. system prompt asks for neutral phrasing + includes the example (sycophancy defense)", async () => {
    const llm = startMockCraftLlm(() => ({
      body: { choices: [{ message: { content: "Does this image show a pattern?" } }] },
    }));
    const gate = makeGate();
    try {
      await craftVisionQuestion(
        fetch,
        makeCraftConfig(llm.port),
        gate,
        "is this the right way to do X?",
        [],
      );
      expect(llm.getCallCount()).toBe(1);
      const req = llm.getRequest(0) as { messages: Array<{ role: string; content: string }> };
      const systemContent = req.messages[0]?.content;
      // System prompt must instruct neutral phrasing.
      expect(systemContent).toContain("Phrase neutrally");
      expect(systemContent).toContain("Does this image show X? Describe if present.");
      expect(systemContent).toContain("NOT 'Describe the X.'");
      // System prompt must forbid instructions.
      expect(systemContent).toContain("Never output instructions");
      // System prompt must include the worked example.
      expect(systemContent).toContain("Example:");
      expect(systemContent).toContain("is this the right way to do X?");
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("5. user prompt includes Conversation intent when originalSystemPrompt present, omits when absent", async () => {
    // With originalSystemPrompt.
    const llmWith = startMockCraftLlm(() => ({
      body: { choices: [{ message: { content: "crafted" } }] },
    }));
    const gate = makeGate();
    try {
      await craftVisionQuestion(
        fetch,
        makeCraftConfig(llmWith.port),
        gate,
        "is this consistent with the pattern?",
        [],
        "You are a code review expert",
      );
      const reqWith = llmWith.getRequest(0) as { messages: Array<{ content: string }> };
      const userContentWith = reqWith.messages[1]?.content;
      expect(userContentWith).toContain("Conversation intent: You are a code review expert");
      expect(userContentWith).toContain("User's question:");
      expect(userContentWith).toContain("Craft a focused vision question:");
    } finally {
      await llmWith.close();
      gate.shutdown();
    }

    // Without originalSystemPrompt — must NOT include "Conversation intent:".
    const llmWithout = startMockCraftLlm(() => ({
      body: { choices: [{ message: { content: "crafted" } }] },
    }));
    const gate2 = makeGate();
    try {
      await craftVisionQuestion(
        fetch,
        makeCraftConfig(llmWithout.port),
        gate2,
        "is this consistent with the pattern?",
        [],
        undefined,
      );
      const reqWithout = llmWithout.getRequest(0) as { messages: Array<{ content: string }> };
      const userContentWithout = reqWithout.messages[1]?.content;
      expect(userContentWithout).not.toContain("Conversation intent:");
      expect(userContentWithout).toContain("User's question:");
    } finally {
      await llmWithout.close();
      gate2.shutdown();
    }
  });

  test("6. user prompt includes Recent conversation context when recentMessages non-empty", async () => {
    const llm = startMockCraftLlm(() => ({
      body: { choices: [{ message: { content: "crafted" } }] },
    }));
    const gate = makeGate();
    try {
      await craftVisionQuestion(
        fetch,
        makeCraftConfig(llm.port),
        gate,
        "is this consistent with the pattern?",
        [
          { role: "user", text: "I was working on a Bun proxy." },
          { role: "user", text: "The cache key uses sha256." },
        ],
      );
      const req = llm.getRequest(0) as { messages: Array<{ content: string }> };
      const userContent = req.messages[1]?.content;
      expect(userContent).toContain("Recent conversation context:");
      expect(userContent).toContain("user: I was working on a Bun proxy.");
      expect(userContent).toContain("user: The cache key uses sha256.");
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("11. crafting cache key: stable for same input, different for different system prompt", () => {
    const adjacent = "is this consistent with the pattern?";
    const key1 = craftingCacheKey(adjacent, undefined);
    const key2 = craftingCacheKey(adjacent, undefined);
    expect(key1).toBe(key2);
    const key3 = craftingCacheKey(adjacent, "You are an expert");
    expect(key3).not.toBe(key1);
    const key4 = craftingCacheKey("different question", undefined);
    expect(key4).not.toBe(key1);
  });
});

// ── Integration tests: VisionHandoff.processBody ─────────────────────────────

describe("Task 7 — crafted integration via VisionHandoff.processBody", () => {
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

  test("7. complex question → vision request contains crafted question (not raw user text)", async () => {
    const crafted =
      "Does this image show a technique or pattern? Describe what technique is visible.";
    const requests: Array<{ body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        requests.push({ body });
        const sys = body.messages?.[0];
        const sysContent = typeof sys?.content === "string" ? sys.content : "";
        if (sysContent.includes("You reformulate user questions")) {
          // Crafting call.
          return Response.json({
            choices: [{ message: { content: crafted } }],
          });
        }
        // Vision call.
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A pattern is visible." },
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
      // "is this consistent with the pattern I described earlier?" contains the
      // relational term "consistent with" → triage routes to "crafted".
      const body = makeOpenAiBody(
        "is this consistent with the pattern I described earlier?",
        RED_PNG_B64,
      );
      await handoff.processBody(body, "openai");
      // 2 calls: 1 crafting + 1 vision.
      expect(requests.length).toBe(2);
      // First call is crafting (system prompt mentions "reformulate").
      const craftReq = requests[0].body as { messages: Array<{ content: string }> };
      expect(craftReq.messages[0].content).toContain("You reformulate user questions");
      // Vision call (second): user text is the crafted question, NOT raw user text.
      const visionReq = requests[1].body as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userContent = visionReq.messages[1].content as Array<{ type: string; text?: string }>;
      const textPart = userContent.find((p) => p.type === "text");
      expect(textPart?.text).toBe(crafted);
      // NOT framed as "the user asked:" — crafted question is neutral.
      expect(textPart?.text).not.toContain("The user asked:");
      // Raw user text must NOT reach the vision model.
      expect(textPart?.text).not.toContain("consistent with the pattern");
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("8. crafting failure → fallback to Strategy A (slotted with raw question + framing)", async () => {
    const requests: Array<{ body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        requests.push({ body });
        const sys = body.messages?.[0];
        const sysContent = typeof sys?.content === "string" ? sys.content : "";
        if (sysContent.includes("You reformulate user questions")) {
          // Crafting call fails with HTTP 500 → craftVisionQuestion returns null.
          return new Response("upstream error", { status: 500 });
        }
        // Vision call.
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
      const body = makeOpenAiBody(
        "is this consistent with the pattern I described earlier?",
        RED_PNG_B64,
      );
      await handoff.processBody(body, "openai");
      // 2 calls: 1 crafting (failed) + 1 vision (slotted fallback).
      expect(requests.length).toBe(2);
      // Vision call uses slotted framing ("The user asked: ...").
      const visionReq = requests[1].body as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userContent = visionReq.messages[1].content as Array<{ type: string; text?: string }>;
      const textPart = userContent.find((p) => p.type === "text");
      expect(textPart?.text).toContain("The user asked:");
      expect(textPart?.text).toContain("consistent with the pattern");
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("9. same complex question twice → context-tier HIT on second call (0 vision on second)", async () => {
    const requests: Array<{ body: unknown }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        requests.push({ body });
        const sys = body.messages?.[0];
        const sysContent = typeof sys?.content === "string" ? sys.content : "";
        if (sysContent.includes("You reformulate user questions")) {
          return Response.json({
            choices: [
              {
                message: {
                  content: "Does this image show a technique or pattern? Describe what is visible.",
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
              message: { role: "assistant", content: "A pattern is visible." },
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
      // Turn 1: MISS → craft + vision call (2 calls). Description is stored
      // under the slotted contextHash (keyed by adjacentText + position +
      // batch + systemPrompt — stable for the same question).
      const body1 = makeOpenAiBody(question, RED_PNG_B64);
      await handoff.processBody(body1, "openai");
      const callsAfterTurn1 = requests.length;
      expect(callsAfterTurn1).toBe(2); // 1 craft + 1 vision
      // Turn 2: SAME question + SAME image → context-tier HIT on the vision
      // description cache (slotted hash is stable). Crafting cache also HITs
      // (same adjacentText + originalSystemPrompt). So 0 calls on turn 2.
      const body2 = makeOpenAiBody(question, RED_PNG_B64);
      await handoff.processBody(body2, "openai");
      expect(requests.length).toBe(callsAfterTurn1); // no new calls
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("10. sycophancy defense: crafted questions use neutral phrasing", async () => {
    const llm = startMockCraftLlm(() => ({
      body: {
        choices: [{ message: { content: "Does this image show a pattern? Describe if present." } }],
      },
    }));
    const gate = makeGate();
    try {
      await craftVisionQuestion(
        fetch,
        makeCraftConfig(llm.port),
        gate,
        "is this the right way to do X?",
        [],
      );
      const req = llm.getRequest(0) as { messages: Array<{ role: string; content: string }> };
      const systemContent = req.messages[0]?.content;
      // Sycophancy defense: the system prompt must instruct neutral phrasing.
      expect(systemContent).toContain("Phrase neutrally");
      expect(systemContent).toContain("Does this image show X? Describe if present.");
      expect(systemContent).toContain("NOT 'Describe the X.'");
      // Must include the worked example so the LLM has a pattern to follow.
      expect(systemContent).toContain("Example:");
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("11-int. crafting cache: same adjacentText + originalSystemPrompt twice → crafting LLM called once", async () => {
    let craftCallCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json().catch(() => ({}))) as {
          messages?: Array<{ role: string; content: unknown }>;
        };
        const sys = body.messages?.[0];
        const sysContent = typeof sys?.content === "string" ? sys.content : "";
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
      // Turn 1: crafting LLM called once + vision call.
      // Use FRESH image bytes each turn so the image-only + vision-description
      // cache doesn't hit — we want to isolate the crafting cache.
      const body1 = makeOpenAiBody(question, RED_PNG_B64);
      await handoff.processBody(body1, "openai");
      expect(craftCallCount).toBe(1);
      // Turn 2: SAME question (same crafting cache key) but DIFFERENT image
      // bytes (swap to blue) so vision-description cache misses and a vision
      // call happens — but crafting cache should HIT, so craftCallCount stays 1.
      const body2 = makeOpenAiBody(question, BLUE_PNG_B64);
      await handoff.processBody(body2, "openai");
      expect(craftCallCount).toBe(1); // cache hit
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });
});

/** OpenAI chat-completions body with image_url + adjacent text. */
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

/** 1x1 blue PNG (base64) — used for crafting cache test (different image bytes). */
const BLUE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

// Keep imports used — Database is referenced indirectly via CaptureDB.
void Database;
