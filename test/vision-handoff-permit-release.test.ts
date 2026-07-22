// Regression test for BUG-01: the vision handoff permit must be released
// exactly once in a `finally` block, even when post-fetch processing throws.
//
// Before the fix, the permit was released via two separate sites (one in the
// catch block, one right after the try/catch). If post-fetch processing ever
// threw between those two points, the release would be skipped.
//
// This test mocks a fetch Response whose `.text()` method throws synchronously
// (before the `.catch(() => "")` handler can attach), simulating a corrupt
// or hostile Response object. The permit must still be released.

import { describe, expect, test } from "bun:test";
import { ConcurrencyGate } from "../src/limiter/index.js";
import { DescriptionCache } from "../src/vision/cache.js";
import { type VisionConfig, VisionHandoff } from "../src/vision/handoff.js";

/** Type-safe accessor to call the private callVisionRecorded method on VisionImageProcessor. */
interface VisionHandoffInternals {
  imageProcessor: {
    callVisionRecorded(imageBytes: Uint8Array, signal?: AbortSignal): Promise<unknown>;
  };
}

function makeConfig(overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    strategy: "always",
    target: "https://vision-mock.example.com/v1/chat/completions",
    model: "test-vision-model",
    prompt: "describe this image",
    promptVersion: 1,
    maxImages: 1,
    maxDescriptionTokens: 300,
    reasoningEffort: null,
    timeoutMs: 5000,
    cacheSize: 10,
    cacheTtlMs: 60000,
    cacheMaxRows: 100,
    persistentCache: false,
    apiKey: null,
    forceInterceptCapable: false,
    concurrency: 1,
    maxDimension: 1024,
    jpegQuality: 80,
    imageFormat: "jpeg",
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
    maxQueueDepth: 10,
    queueTimeoutMs: 1000,
    intentions: { vision: 1 },
  });
}

describe("BUG-01: permit released in finally when post-fetch processing throws", () => {
  test("permit is released when response.text() throws synchronously", async () => {
    const gate = makeGate();
    const cache = new DescriptionCache(10, 60000, null);
    const handoff = new VisionHandoff(makeConfig(), cache, null, gate);

    // Mock fetch to return a Response whose .text() throws synchronously.
    // This simulates a corrupt/hostile Response that causes post-fetch
    // processing to throw before the permit is released.
    const originalFetch = globalThis.fetch;
    const throwingText = (): Promise<string> => {
      throw new Error("text() threw synchronously");
    };
    const mockResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: throwingText,
    } as unknown as Response;
    globalThis.fetch = (async () => mockResponse) as unknown as typeof fetch;

    try {
      const internals = handoff as unknown as VisionHandoffInternals;
      // The call should reject because .text() throws synchronously.
      await expect(
        internals.imageProcessor.callVisionRecorded(new Uint8Array([1, 2, 3, 4])),
      ).rejects.toThrow();

      // release() is called synchronously, but the gate defers the actual
      // active-count decrement via setTimeout(fn, releaseCooldownMs). With
      // releaseCooldownMs=0 the timer fires on the next macrotask tick.
      await new Promise((r) => setTimeout(r, 10));
      // The permit must have been released despite the throw.
      expect(gate.getIntentionActive("vision")).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("permit is released on normal success path", async () => {
    const gate = makeGate();
    const cache = new DescriptionCache(10, 60000, null);
    const handoff = new VisionHandoff(makeConfig(), cache, null, gate);

    const originalFetch = globalThis.fetch;
    const okBody = JSON.stringify({
      choices: [{ message: { content: "a description" } }],
    });
    globalThis.fetch = (async () =>
      new Response(okBody, {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      const internals = handoff as unknown as VisionHandoffInternals;
      const result = (await internals.imageProcessor.callVisionRecorded(
        new Uint8Array([1, 2, 3, 4]),
      )) as {
        status: string;
      };
      expect(result.status).toBe("ok");
      await new Promise((r) => setTimeout(r, 10));
      expect(gate.getIntentionActive("vision")).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("permit is released on fetch failure", async () => {
    const gate = makeGate();
    const cache = new DescriptionCache(10, 60000, null);
    const handoff = new VisionHandoff(makeConfig(), cache, null, gate);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;

    try {
      const internals = handoff as unknown as VisionHandoffInternals;
      const result = (await internals.imageProcessor.callVisionRecorded(
        new Uint8Array([1, 2, 3, 4]),
      )) as {
        status: string;
      };
      expect(result.status).toBe("fetch_error");
      await new Promise((r) => setTimeout(r, 10));
      expect(gate.getIntentionActive("vision")).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
