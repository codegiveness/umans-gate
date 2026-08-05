// Unit tests for src/vision/handoff.ts — update-failure + capture-failed-on-reject.
// Verifies that when updateVisionCapture or callVisionRecorded throws,
// the vision DB row transitions to "failed", addRecord still runs, inflight cleaned.

import { describe, expect, test } from "bun:test";
import { CaptureDB } from "../../src/db.js";
import { DescriptionCache } from "../../src/vision/cache.js";
import { type VisionConfig, VisionHandoff } from "../../src/vision/handoff.js";

const RED_PNG_B64 =
  // biome-ignore lint/security/noSecrets: 1x1 red PNG test fixture, not a secret.
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeConfig(target: string, overrides: Partial<VisionConfig> = {}): VisionConfig {
  return {
    strategy: "always",
    target,
    model: "umans-flash",
    prompt: "Describe the image",
    promptVersion: 1,
    maxImages: 4,
    maxDescriptionTokens: 100,
    reasoningEffort: null,
    timeoutMs: 5000,
    cacheSize: 100,
    cacheTtlMs: 60000,
    cacheMaxRows: 1000,
    persistentCache: false,
    apiKey: "test-key",
    forceInterceptCapable: false,
    concurrency: 2,
    maxDimension: 512,
    jpegQuality: 80,
    imageFormat: "jpeg",
    imageDetail: "auto",
    visionWeight: 1,
    backgroundVision: false,
    ...overrides,
  };
}

const IMAGE_BODY = {
  model: "umans-glm-5.2",
  max_tokens: 50,
  messages: [
    {
      role: "user",
      content: [
        { type: "text", text: "What is in this image?" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${RED_PNG_B64}` } },
      ],
    },
  ],
};

describe("vision update failure (V10)", () => {
  test("updateVisionCapture throws -> row 'failed', addRecord still called, inflight cleaned", async () => {
    const visionServer = Bun.serve({
      port: 0,
      async fetch() {
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

    const db = new CaptureDB({ dbPath: ":memory:", maxCaptures: 100 });
    const cache = new DescriptionCache(100, 60000, null);
    const handoff = new VisionHandoff(
      makeConfig(`http://127.0.0.1:${visionServer.port ?? 0}/v1/chat/completions`),
      cache,
      null,
      undefined,
      db,
    );

    const originalSetState = db.setState.bind(db);
    const setStateCalls: Array<{ id: number; state: string }> = [];
    let updateCallCount = 0;
    db.updateVisionCapture = () => {
      updateCallCount++;
      throw new Error("simulated updateVisionCapture failure");
    };
    db.setState = (id: number, state: Parameters<typeof originalSetState>[1]) => {
      setStateCalls.push({ id, state });
      return originalSetState(id, state);
    };

    await handoff.processBody(IMAGE_BODY, "openai");
    await new Promise((r) => setTimeout(r, 50));

    expect(updateCallCount).toBe(1);

    const failedCalls = setStateCalls.filter((s) => s.state === "failed");
    expect(failedCalls.length).toBe(1);

    const visionRows = db.listVisionCaptures(100);
    expect(visionRows.length).toBeGreaterThanOrEqual(1);
    expect(visionRows[0].state).toBe("failed");

    const records = handoff.getRecords(100);
    expect(records.length).toBeGreaterThanOrEqual(1);
    const okRecord = records.find((r) => r.status === "ok");
    expect(okRecord).toBeDefined();
    expect(okRecord?.description).toBe("A red pixel.");

    const inflight = (
      handoff as unknown as {
        imageProcessor: { inflight: Map<string, unknown> };
      }
    ).imageProcessor.inflight;
    expect(inflight.size).toBe(0);

    visionServer.stop(true);
  });
});

describe("vision capture failed on rejection", () => {
  test("vision row state is 'failed' when callVisionRecorded rejects", async () => {
    const db = new CaptureDB({ dbPath: ":memory:", maxCaptures: 100 });
    const cache = new DescriptionCache(100, 60000, null);
    const handoff = new VisionHandoff(
      makeConfig("http://127.0.0.1:0/v1/chat/completions"),
      cache,
      null,
      undefined,
      db,
    );

    (
      handoff as unknown as {
        imageProcessor: { callVisionRecorded: () => Promise<never> };
      }
    ).imageProcessor.callVisionRecorded = async () => {
      throw new Error("test rejection");
    };

    await handoff.processBody(IMAGE_BODY, "openai");
    await new Promise((r) => setTimeout(r, 50));

    const visionRows = db.listVisionCaptures(100);
    expect(visionRows.length).toBeGreaterThanOrEqual(1);
    const vc = visionRows[0];
    expect(vc.state).toBe("failed");
  });
});
