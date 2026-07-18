// Integration tests for Task 6: selective decomposition (DecoVQA+ pattern).
//
// Verifies:
//   - decomposeIfNeeded fast path (single image → decomposed: false)
//   - decomposeIfNeeded success path (multi-image with references → per-image sub-questions)
//   - decomposeIfNeeded failure paths (HTTP error, timeout, parse error, length mismatch)
//     → { decomposed: false } → slotted fallback
//   - Neutrally-phrased system prompt (sycophancy defense)
//   - Gate-acquisition (Amendment A6): GateError → { decomposed: false }
//   - Decomposition cache (in-memory): same batch key → LLM called only once
//   - End-to-end via VisionHandoff.processBody:
//     * Per-image sub-question reaches each vision call (not framed as "the user asked")
//     * Positional labels [Image 1:, [Image 2: in replacement text
//     * Image-only tier HIT when same images + different question (no decomposition call)
//
// Run: bun test test/vision-decompose.test.ts

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../src/db.js";
import { ConcurrencyGate, GateError } from "../src/limiter/index.js";
import { DescriptionCache } from "../src/vision/cache.js";
import {
  type DecomposeConfig,
  type DecompositionInput,
  decomposeIfNeeded,
  decompositionCacheKey,
} from "../src/vision/decompose.js";
import { VisionHandoff } from "../src/vision/handoff.js";
import type { VisionConfig } from "../src/vision/handoff.js";
import { PersistentDescriptionStore } from "../src/vision/persistent-cache.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── test image data ──────────────────────────────────────────────────────────

/** 1x1 red PNG (base64). */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** 1x1 blue PNG (base64). */
const BLUE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

const WRAPPED_PREFIX =
  "[Image content — analyzed by vision module, shown as text because the active model cannot see images:]";

// ── helpers ───────────────────────────────────────────────────────────────────

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `vision-decompose-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

function makeDecomposeConfig(
  port: number,
  overrides: Partial<DecomposeConfig> = {},
): DecomposeConfig {
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
 * lets each test decide what to return (success JSON array, error, malformed
 * JSON, etc.) so we can exercise every failure path.
 */
function startMockDecomposeLlm(
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

/** Mock vision upstream that returns a fixed description per call (for integration tests). */
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

/** OpenAI body with a system message. */
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

// ── Unit tests: decomposeIfNeeded ────────────────────────────────────────────

describe("Task 6 — decomposeIfNeeded unit tests", () => {
  test("1. fast path: single image returns { decomposed: false } without LLM call", async () => {
    const llm = startMockDecomposeLlm(() => ({
      body: { choices: [{ message: { content: "[]" } }] },
    }));
    const gate = makeGate();
    try {
      const input: DecompositionInput = {
        userQuestion: "describe the images",
        imageCount: 1,
      };
      const result = await decomposeIfNeeded(fetch, makeDecomposeConfig(llm.port), gate, input);
      expect(result.decomposed).toBe(false);
      expect(result.perImageQuestions).toBeUndefined();
      // LLM never called.
      expect(llm.getCallCount()).toBe(0);
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("2. success: multi-image with references → N neutrally-phrased sub-questions", async () => {
    const subQuestions = [
      "Does this image contain red? Describe if present.",
      "Does this image contain green? Describe if present.",
    ];
    const llm = startMockDecomposeLlm(() => ({
      body: {
        choices: [{ message: { content: JSON.stringify(subQuestions) } }],
      },
    }));
    const gate = makeGate();
    try {
      const input: DecompositionInput = {
        userQuestion: "see red on image A and green on image B",
        imageCount: 2,
      };
      const result = await decomposeIfNeeded(fetch, makeDecomposeConfig(llm.port), gate, input);
      expect(result.decomposed).toBe(true);
      expect(result.perImageQuestions).toHaveLength(2);
      expect(result.perImageQuestions?.[0]).toBe(subQuestions[0]);
      expect(result.perImageQuestions?.[1]).toBe(subQuestions[1]);
      expect(llm.getCallCount()).toBe(1);
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("3a. LLM HTTP error → { decomposed: false } (slotted fallback)", async () => {
    const llm = startMockDecomposeLlm(() => ({ status: 500, body: { error: "upstream error" } }));
    const gate = makeGate();
    try {
      const result = await decomposeIfNeeded(fetch, makeDecomposeConfig(llm.port), gate, {
        userQuestion: "see red on image A",
        imageCount: 2,
      });
      expect(result.decomposed).toBe(false);
      expect(result.perImageQuestions).toBeUndefined();
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("3b. LLM timeout → { decomposed: false } (slotted fallback)", async () => {
    // Server that never responds within the timeout window.
    const server = Bun.serve({
      port: 0,
      async fetch() {
        await sleep(500);
        return Response.json({});
      },
    });
    const gate = makeGate();
    try {
      const result = await decomposeIfNeeded(
        fetch,
        makeDecomposeConfig(server.port),
        gate,
        { userQuestion: "see red on image A", imageCount: 2 },
        undefined,
        50, // 50ms timeout — well under the 500ms server delay
      );
      expect(result.decomposed).toBe(false);
    } finally {
      server.stop(true);
      gate.shutdown();
      await sleep(50);
    }
  });

  test("3c. malformed JSON content → { decomposed: false }", async () => {
    const llm = startMockDecomposeLlm(() => ({
      body: { choices: [{ message: { content: "not valid json" } }] },
    }));
    const gate = makeGate();
    try {
      const result = await decomposeIfNeeded(fetch, makeDecomposeConfig(llm.port), gate, {
        userQuestion: "see red on image A",
        imageCount: 2,
      });
      expect(result.decomposed).toBe(false);
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("3d. array length mismatch → { decomposed: false }", async () => {
    const llm = startMockDecomposeLlm(() => ({
      body: {
        choices: [{ message: { content: JSON.stringify(["only one"]) } }],
      },
    }));
    const gate = makeGate();
    try {
      const result = await decomposeIfNeeded(fetch, makeDecomposeConfig(llm.port), gate, {
        userQuestion: "see red on image A and green on image B",
        imageCount: 2,
      });
      expect(result.decomposed).toBe(false);
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("4. system prompt asks for neutral phrasing (sycophancy defense)", async () => {
    const llm = startMockDecomposeLlm(() => ({
      body: {
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
      },
    }));
    const gate = makeGate();
    try {
      await decomposeIfNeeded(fetch, makeDecomposeConfig(llm.port), gate, {
        userQuestion: "see red on image A and green on image B",
        imageCount: 2,
      });
      expect(llm.getCallCount()).toBe(1);
      const req = llm.getRequest(0) as { messages: Array<{ role: string; content: string }> };
      const systemContent = req.messages[0]?.content;
      // System prompt must instruct neutral phrasing.
      expect(systemContent).toContain("neutrally phrased");
      expect(systemContent).toContain("Does this image contain X? Describe if present.");
      // System prompt must forbid leading "Describe the X" phrasing.
      expect(systemContent).toContain("Never use leading phrasing");
      // The mock-returned sub-questions follow the neutral pattern.
      const userContent = req.messages[1]?.content;
      expect(userContent).toContain("User's question:");
      // When originalSystemPrompt is present, it threads into the user prompt.
      const llm2 = startMockDecomposeLlm(() => ({
        body: { choices: [{ message: { content: JSON.stringify(["q1", "q2"]) } }] },
      }));
      try {
        await decomposeIfNeeded(fetch, makeDecomposeConfig(llm2.port), gate, {
          userQuestion: "see red on image A and green on image B",
          imageCount: 2,
          originalSystemPrompt: "You are a color expert",
        });
        const req2 = llm2.getRequest(0) as { messages: Array<{ role: string; content: string }> };
        expect(req2.messages[1]?.content).toContain("Conversation intent: You are a color expert");
      } finally {
        await llm2.close();
      }
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("8. GateError (queue_full) → { decomposed: false } (slotted fallback)", async () => {
    const llm = startMockDecomposeLlm(() => ({
      body: { choices: [{ message: { content: JSON.stringify(["q1", "q2"]) } }] },
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
      const result = await decomposeIfNeeded(fetch, makeDecomposeConfig(llm.port), gate, {
        userQuestion: "see red on image A and green on image B",
        imageCount: 2,
      });
      expect(result.decomposed).toBe(false);
      // LLM never called because gate rejected.
      expect(llm.getCallCount()).toBe(0);
    } finally {
      occupying.release();
      await llm.close();
      gate.shutdown();
    }
  });

  test("9. decomposition cache: same batch key → LLM called once", async () => {
    // Two LLM servers: first used for the real call, second would be called
    // only if the cache misses. We point both calls at the same server.
    const llm = startMockDecomposeLlm(() => ({
      body: { choices: [{ message: { content: JSON.stringify(["q1", "q2"]) } }] },
    }));
    const gate = makeGate();
    try {
      const config = makeDecomposeConfig(llm.port);
      const input: DecompositionInput = {
        userQuestion: "see red on image A and green on image B",
        imageCount: 2,
      };
      // First call: cache miss → LLM called.
      const r1 = await decomposeIfNeeded(fetch, config, gate, input);
      expect(r1.decomposed).toBe(true);
      expect(llm.getCallCount()).toBe(1);
      // Second call: would be a cache miss at the decomposeIfNeeded level
      // (decomposeIfNeeded itself has no cache — the cache lives in
      // VisionHandoff). So this test asserts the cache key formula is stable:
      const key1 = decompositionCacheKey(input.userQuestion, input.imageCount, undefined);
      const key2 = decompositionCacheKey(input.userQuestion, input.imageCount, undefined);
      expect(key1).toBe(key2);
      // Different intent → different key.
      const key3 = decompositionCacheKey(input.userQuestion, input.imageCount, "different intent");
      expect(key3).not.toBe(key1);
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });
});

// ── Integration tests: VisionHandoff.processBody ─────────────────────────────

describe("Task 6 — decomposed integration via VisionHandoff.processBody", () => {
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

  test("5. per-image sub-question reaches each vision call (red for Image 1, green for Image 2)", async () => {
    // Single capturing server that routes by request body shape:
    //   - decomposition calls (system prompt mentions "decompose a multi-image")
    //   - vision calls (everything else with an image_url)
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
      // "see red on image A and green on image B" → triage: decomposed.
      const body = makeOpenAiBody(
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      await handoff.processBody(body, "openai");
      // 3 calls: 1 decomposition + 2 vision.
      expect(requests.length).toBe(3);
      // First call is the decomposition (system prompt mentions "decompose").
      const decomposeReq = requests[0].body as { messages: Array<{ content: string }> };
      expect(decomposeReq.messages[0].content).toContain("decompose a multi-image");
      // Vision call #1 (Image 1): user text is the RED sub-question.
      const visionReq1 = requests[1].body as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userContent1 = visionReq1.messages[1].content as Array<{ type: string; text?: string }>;
      const textPart1 = userContent1.find((p) => p.type === "text");
      expect(textPart1?.text).toContain("Does this image contain red?");
      // NOT framed as "the user asked" — decomposed questions are neutral.
      expect(textPart1?.text).not.toContain("The user asked:");
      // Vision call #2 (Image 2): user text is the GREEN sub-question.
      const visionReq2 = requests[2].body as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userContent2 = visionReq2.messages[1].content as Array<{ type: string; text?: string }>;
      const textPart2 = userContent2.find((p) => p.type === "text");
      expect(textPart2?.text).toContain("Does this image contain green?");
      expect(textPart2?.text).not.toContain("The user asked:");
      // System messages carry batch context.
      const sys1 = visionReq1.messages[0].content as string;
      const sys2 = visionReq2.messages[0].content as string;
      expect(sys1).toContain("You are describing Image 1 of 2.");
      expect(sys2).toContain("You are describing Image 2 of 2.");
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("6. positional labels in replacement text ([Image 1:, [Image 2:)", async () => {
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
      // 3 text blocks: original user text + 2 image-replacement labels.
      expect(textBlocks.length).toBe(3);
      const labeled = textBlocks.filter((t) => t.text?.includes("[Image "));
      expect(labeled.length).toBe(2);
      expect(labeled[0]?.text).toContain("[Image 1:\n");
      expect(labeled[0]?.text).toContain(WRAPPED_PREFIX);
      expect(labeled[1]?.text).toContain("[Image 2:\n");
      expect(labeled[1]?.text).toContain(WRAPPED_PREFIX);
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("7. image-only tier HIT: same 2 images + different question → 0 decomposition, 0 vision", async () => {
    // First request: decomposition + 2 vision calls populate the image-only tier.
    // Second request: same images, different question → image-only tier HIT.
    // For image-only tier to HIT, the image-only cache key (no contextHash)
    // must match — which it does because images are byte-identical.
    // The decomposition call only happens when batch triage says "decomposed",
    // and that only happens for multi-image with image references. The second
    // request uses a question WITHOUT image references so triage says "slotted"
    // — no decomposition call. This still tests the cache: the same images get
    // an image-only tier hit on the second request.
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
      // Turn 1: "see red on image A and green on image B" + 2 images.
      // Triage → decomposed. Decomposition + 2 vision calls = 3 calls total.
      const body1 = makeOpenAiBody(
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      await handoff.processBody(body1, "openai");
      const callsAfterTurn1 = capturing.length;
      expect(callsAfterTurn1).toBe(3); // 1 decompose + 2 vision
      // Turn 2: same 2 images + a question WITHOUT image references.
      // Triage → slotted (multi-image, no references, no comparatives).
      // No decomposition call. Image-only tier HIT for both images → 0 vision.
      const body2 = makeOpenAiBody("explain what you see", RED_PNG_B64, BLUE_PNG_B64);
      await handoff.processBody(body2, "openai");
      // No new calls — image-only tier hit.
      expect(capturing.length).toBe(callsAfterTurn1);
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("decomposed with originalSystemPrompt threads intent into decomposition + vision calls", async () => {
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
      // Decomposition call's user prompt contains the conversation intent.
      const decomposeReq = capturing[0].body as { messages: Array<{ content: string }> };
      expect(decomposeReq.messages[1].content).toContain(
        "Conversation intent: You are a color expert",
      );
      // Vision calls' system messages carry the original intent suffix.
      const visionReq1 = capturing[1].body as { messages: Array<{ content: string }> };
      expect(visionReq1.messages[0].content).toContain(
        "[Original conversation intent: You are a color expert]",
      );
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("decomposition cache: same batch key twice → LLM called once", async () => {
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
      // Turn 1: decomposition LLM call + 2 vision calls.
      // Use FRESH images each turn so the image-only tier doesn't hit.
      // We use a different red/blue image variant for turn 2 to avoid image-cache hits,
      // but the SAME question so the decomposition cache key is identical.
      const body1 = makeOpenAiBody(
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      await handoff.processBody(body1, "openai");
      expect(decomposeCallCount).toBe(1);
      // Turn 2: SAME question + SAME imageCount (decomposition cache key matches),
      // but DIFFERENT image bytes (so image-only tier misses and vision is called).
      // The decomposition cache should HIT — decomposeCallCount stays at 1.
      const body2 = makeOpenAiBody(
        "see red on image A and green on image B",
        BLUE_PNG_B64, // swap order so image bytes differ
        RED_PNG_B64,
      );
      await handoff.processBody(body2, "openai");
      expect(decomposeCallCount).toBe(1); // cache hit
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });

  test("decompose failure falls back to slotted (Amendment A6 fallback)", async () => {
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
          // Return malformed JSON → decompose returns { decomposed: false }.
          return Response.json({
            choices: [{ message: { content: "not valid json" } }],
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
      const body = makeOpenAiBody(
        "see red on image A and green on image B",
        RED_PNG_B64,
        BLUE_PNG_B64,
      );
      await handoff.processBody(body, "openai");
      // 3 calls: 1 decompose (failed) + 2 vision (slotted fallback).
      expect(capturing.length).toBe(3);
      // Vision call #1 uses the slotted framing ("The user asked: ...").
      const visionReq1 = capturing[1].body as {
        messages: Array<{ role: string; content: unknown }>;
      };
      const userContent1 = visionReq1.messages[1].content as Array<{ type: string; text?: string }>;
      const textPart1 = userContent1.find((p) => p.type === "text");
      expect(textPart1?.text).toContain("The user asked:");
    } finally {
      server.stop(true);
      await sleep(100);
    }
  });
});

// Keep imports used — Database is referenced indirectly via CaptureDB.
void Database;
void GateError;
