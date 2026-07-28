// Unit tests for src/vision/craft.ts — craftVisionQuestion + craftingCacheKey.
// Direct calls with mock LLM server + gate. No proxy.

import { describe, expect, test } from "bun:test";
import { ConcurrencyGate } from "../../src/limiter/index.js";
import { type CraftConfig, craftingCacheKey, craftVisionQuestion } from "../../src/vision/craft.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

describe("craftVisionQuestion unit tests", () => {
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

  test("2a. HTTP error -> null (slotted fallback)", async () => {
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

  test("2b. timeout -> null (slotted fallback)", async () => {
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
        makeCraftConfig(server.port ?? 0),
        gate,
        "is this the right way to do X?",
        [],
        undefined,
        undefined,
        50,
      );
      expect(result).toBeNull();
    } finally {
      server.stop(true);
      gate.shutdown();
      await sleep(50);
    }
  });

  test("2c. malformed JSON body -> null", async () => {
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

  test("2d. empty content string -> null", async () => {
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

  test("3. GateError (queue_full) -> null (slotted fallback)", async () => {
    const llm = startMockCraftLlm(() => ({
      body: { choices: [{ message: { content: "crafted question" } }] },
    }));
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
      expect(llm.getCallCount()).toBe(0);
    } finally {
      occupying.release();
      await llm.close();
      gate.shutdown();
    }
  });

  test("4. system prompt asks for neutral phrasing + includes the example", async () => {
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
      expect(systemContent).toContain("Phrase neutrally");
      expect(systemContent).toContain("Does this image show X? Describe if present.");
      expect(systemContent).toContain("NOT 'Describe the X.'");
      expect(systemContent).toContain("Never output instructions");
      expect(systemContent).toContain("Example:");
      expect(systemContent).toContain("is this the right way to do X?");
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("5. user prompt includes Conversation intent when originalSystemPrompt present, omits when absent", async () => {
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
