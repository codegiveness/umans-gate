// Unit tests for src/vision/decompose.ts — decomposeIfNeeded + decompositionCacheKey.
// Direct calls with mock LLM server + gate. No proxy.

import { describe, expect, test } from "bun:test";
import { ConcurrencyGate } from "../../src/limiter/index.js";
import {
  type DecomposeConfig,
  type DecompositionInput,
  decomposeIfNeeded,
  decompositionCacheKey,
} from "../../src/vision/decompose.js";

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

describe("decomposeIfNeeded unit tests", () => {
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
      expect(llm.getCallCount()).toBe(0);
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });

  test("2. success: multi-image with references -> N neutrally-phrased sub-questions", async () => {
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

  test("3a. LLM HTTP error -> { decomposed: false }", async () => {
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

  test("3b. LLM timeout -> { decomposed: false }", async () => {
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
        makeDecomposeConfig(server.port ?? 0),
        gate,
        { userQuestion: "see red on image A", imageCount: 2 },
        undefined,
        50,
      );
      expect(result.decomposed).toBe(false);
    } finally {
      server.stop(true);
      gate.shutdown();
      await sleep(50);
    }
  });

  test("3c. malformed JSON content -> { decomposed: false }", async () => {
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

  test("3d. array length mismatch -> { decomposed: false }", async () => {
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

  test("4. system prompt asks for neutral phrasing + threads originalSystemPrompt", async () => {
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
      expect(systemContent).toContain("neutrally phrased");
      expect(systemContent).toContain("Does this image contain X? Describe if present.");
      expect(systemContent).toContain("Never use leading phrasing");
      const userContent = req.messages[1]?.content;
      expect(userContent).toContain("User's question:");

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

  test("8. GateError (queue_full) -> { decomposed: false }", async () => {
    const llm = startMockDecomposeLlm(() => ({
      body: { choices: [{ message: { content: JSON.stringify(["q1", "q2"]) } }] },
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
      const result = await decomposeIfNeeded(fetch, makeDecomposeConfig(llm.port), gate, {
        userQuestion: "see red on image A and green on image B",
        imageCount: 2,
      });
      expect(result.decomposed).toBe(false);
      expect(llm.getCallCount()).toBe(0);
    } finally {
      occupying.release();
      await llm.close();
      gate.shutdown();
    }
  });

  test("9. decomposition cache key: stable for same input, different for different system prompt", async () => {
    const llm = startMockDecomposeLlm(() => ({
      body: { choices: [{ message: { content: JSON.stringify(["q1", "q2"]) } }] },
    }));
    const gate = makeGate();
    try {
      const input: DecompositionInput = {
        userQuestion: "see red on image A and green on image B",
        imageCount: 2,
      };
      const r1 = await decomposeIfNeeded(fetch, makeDecomposeConfig(llm.port), gate, input);
      expect(r1.decomposed).toBe(true);
      expect(llm.getCallCount()).toBe(1);

      const key1 = decompositionCacheKey(input.userQuestion, input.imageCount, undefined);
      const key2 = decompositionCacheKey(input.userQuestion, input.imageCount, undefined);
      expect(key1).toBe(key2);
      const key3 = decompositionCacheKey(input.userQuestion, input.imageCount, "different intent");
      expect(key3).not.toBe(key1);
    } finally {
      await llm.close();
      gate.shutdown();
    }
  });
});
