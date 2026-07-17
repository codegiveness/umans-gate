// V7: Classify gate acquire errors separately from fetch errors in vision.
//
// Before the fix, `callVisionRecorded` treated every error thrown inside the
// inner try (which wraps both `gate.acquire()` and `fetch()`) as a generic
// `fetch_error`. A `GateError` (circuit_open / queue_full / timeout) is a
// concurrency-gate rejection, not a network failure — misclassifying it hid
// gate health from the dashboard and conflated two unrelated failure modes.
//
// This test verifies that:
//   1. GateError("circuit_open")  -> status "gate_rejected", error contains "circuit_open"
//   2. GateError("queue_full")     -> status "gate_rejected"
//   3. GateError("timeout")        -> status "gate_rejected"
//   4. Regular fetch error         -> status "fetch_error" (unchanged)
//   5. When acquire throws, the permit is null (not leaked) — the finally
//      block's `permit?.release()` is a no-op and the gate active count stays 0.

import { describe, expect, test } from "bun:test";
import { ConcurrencyGate } from "../src/limiter/index.js";
import { GateError } from "../src/limiter/types.js";
import { DescriptionCache } from "../src/vision/cache.js";
import { type VisionConfig, VisionHandoff } from "../src/vision/handoff.js";

/** Type-safe accessor to call the private callVisionRecorded method. */
interface VisionHandoffInternals {
  callVisionRecorded(
    imageBytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<{
    status: string;
    error: string | null;
    description: string;
    httpStatus: number | null;
    requestBody: string;
    requestHeaders: string;
    responseBody: string;
    responseHeaders: string;
    usage: unknown;
  }>;
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
    timeoutMs: 0,
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

describe("V7: classify GateError separately from fetch errors", () => {
  test('GateError("circuit_open") -> status "gate_rejected", error contains code', async () => {
    const gate = makeGate();
    const cache = new DescriptionCache(10, 60000, null);
    const handoff = new VisionHandoff(makeConfig(), cache, null, gate);

    const originalAcquire = gate.acquire.bind(gate);
    gate.acquire = (() => {
      throw new GateError("circuit_open", "circuit breaker is open");
    }) as typeof gate.acquire;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("should not be reached");
    }) as unknown as typeof fetch;

    try {
      const internals = handoff as unknown as VisionHandoffInternals;
      const result = await internals.callVisionRecorded(new Uint8Array([1, 2, 3, 4]));
      expect(result.status).toBe("gate_rejected");
      expect(result.error).toContain("circuit_open");
    } finally {
      globalThis.fetch = originalFetch;
      gate.acquire = originalAcquire;
    }
  });

  test('GateError("queue_full") -> status "gate_rejected"', async () => {
    const gate = makeGate();
    const cache = new DescriptionCache(10, 60000, null);
    const handoff = new VisionHandoff(makeConfig(), cache, null, gate);

    const originalAcquire = gate.acquire.bind(gate);
    gate.acquire = (() => {
      throw new GateError("queue_full", "queue is full");
    }) as typeof gate.acquire;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("should not be reached");
    }) as unknown as typeof fetch;

    try {
      const internals = handoff as unknown as VisionHandoffInternals;
      const result = await internals.callVisionRecorded(new Uint8Array([1, 2, 3, 4]));
      expect(result.status).toBe("gate_rejected");
      expect(result.error).toContain("queue_full");
    } finally {
      globalThis.fetch = originalFetch;
      gate.acquire = originalAcquire;
    }
  });

  test('GateError("timeout") -> status "gate_rejected"', async () => {
    const gate = makeGate();
    const cache = new DescriptionCache(10, 60000, null);
    const handoff = new VisionHandoff(makeConfig(), cache, null, gate);

    const originalAcquire = gate.acquire.bind(gate);
    gate.acquire = (() => {
      throw new GateError("timeout", "queue wait timed out");
    }) as typeof gate.acquire;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("should not be reached");
    }) as unknown as typeof fetch;

    try {
      const internals = handoff as unknown as VisionHandoffInternals;
      const result = await internals.callVisionRecorded(new Uint8Array([1, 2, 3, 4]));
      expect(result.status).toBe("gate_rejected");
      expect(result.error).toContain("timeout");
    } finally {
      globalThis.fetch = originalFetch;
      gate.acquire = originalAcquire;
    }
  });

  test("regular fetch error -> status fetch_error (unchanged)", async () => {
    const gate = makeGate();
    const cache = new DescriptionCache(10, 60000, null);
    const handoff = new VisionHandoff(makeConfig(), cache, null, gate);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network error");
    }) as unknown as typeof fetch;

    try {
      const internals = handoff as unknown as VisionHandoffInternals;
      const result = await internals.callVisionRecorded(new Uint8Array([1, 2, 3, 4]));
      expect(result.status).toBe("fetch_error");
      expect(result.error).toContain("network error");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("permit is null (not leaked) when acquire throws GateError", async () => {
    const gate = makeGate();
    const cache = new DescriptionCache(10, 60000, null);
    const handoff = new VisionHandoff(makeConfig(), cache, null, gate);

    const originalAcquire = gate.acquire.bind(gate);
    gate.acquire = (() => {
      throw new GateError("circuit_open", "circuit breaker is open");
    }) as typeof gate.acquire;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("should not be reached");
    }) as unknown as typeof fetch;

    try {
      const internals = handoff as unknown as VisionHandoffInternals;
      await internals.callVisionRecorded(new Uint8Array([1, 2, 3, 4]));
      // releaseCooldownMs is 0; the active count should still be 0 because
      // acquire threw, so the finally block's permit?.release() was a no-op
      // and no permit was ever granted against the gate's intention counter.
      await new Promise((r) => setTimeout(r, 10));
      expect(gate.getIntentionActive("vision")).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      gate.acquire = originalAcquire;
    }
  });
});
