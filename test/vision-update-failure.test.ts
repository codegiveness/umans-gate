// Regression test (V10): if updateVisionCapture throws inside processImage,
// the vision DB row must transition to "failed" (not stay "streaming"),
// addRecord must still run (record not lost), and the inflight entry must
// still be cleaned up. Before the fix, updateVisionCapture had no try/catch,
// so a throw propagated out of processImage, skipped addRecord, and left the
// row stuck in "streaming".

import { describe, expect, test } from "bun:test";
import { CaptureDB } from "../src/db.js";
import { DescriptionCache } from "../src/vision/cache.js";
import { VisionHandoff } from "../src/vision/handoff.js";

/** 1x1 red PNG (base64). */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeConfig(target: string): VisionHandoff["config"] {
  return {
    strategy: "always",
    target,
    model: "gpt-4o",
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
  };
}

describe("vision update failure (V10)", () => {
  test("updateVisionCapture throws → row 'failed', addRecord still called, inflight cleaned", async () => {
    // Mock vision upstream returning a successful description so the flow
    // reaches updateVisionCapture (the call under test).
    const visionServer = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "gpt-4o",
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
      makeConfig(`http://127.0.0.1:${visionServer.port}/v1/chat/completions`),
      cache,
      null,
      undefined,
      db,
    );

    // Patch updateVisionCapture to throw — simulates a SQLite write failure
    // on the final UPDATE (e.g. disk full, locked transaction).
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

    const body = {
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

    // processBody uses Promise.allSettled internally so it won't throw; the
    // rejection from processImage is swallowed into a failure placeholder.
    await handoff.processBody(body, "openai");
    await new Promise((r) => setTimeout(r, 50));

    // (1) updateVisionCapture was called and threw.
    expect(updateCallCount).toBe(1);

    // (2) setState was called with "streaming" then "failed".
    const failedCalls = setStateCalls.filter((s) => s.state === "failed");
    expect(failedCalls.length).toBe(1);

    // (3) The vision DB row reached "failed" state (not stuck "streaming").
    const visionRows = db.listVisionCaptures(100);
    expect(visionRows.length).toBeGreaterThanOrEqual(1);
    expect(visionRows[0].state).toBe("failed");

    // (4) addRecord was still called — the record is not lost.
    const records = handoff.getRecords(100);
    expect(records.length).toBeGreaterThanOrEqual(1);
    const okRecord = records.find((r) => r.status === "ok");
    expect(okRecord).toBeDefined();
    expect(okRecord?.description).toBe("A red pixel.");

    // (5) inflight entry was cleaned up (finally block still ran).
    const inflight = (handoff as unknown as { inflight: Map<string, unknown> }).inflight;
    expect(inflight.size).toBe(0);

    visionServer.stop(true);
  });
});
