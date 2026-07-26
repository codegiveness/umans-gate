// Regression test: when processImage's visionPromise rejects, the vision DB
// row must be marked "failed" instead of staying "streaming" forever.
// We construct a real VisionHandoff with an in-memory CaptureDB and patch
// callVisionRecorded to throw, exercising the actual catch path.

import { describe, expect, test } from "bun:test";
import { CaptureDB } from "../src/db.js";
import { DescriptionCache } from "../src/vision/cache.js";
import { VisionHandoff } from "../src/vision/handoff.js";

const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeConfig(): VisionHandoff["config"] {
  return {
    strategy: "always",
    target: "http://127.0.0.1:0/v1/chat/completions",
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
  };
}

describe("vision capture failed on rejection", () => {
  test("vision row state is 'failed' when callVisionRecorded rejects", async () => {
    const db = new CaptureDB({ dbPath: ":memory:", maxCaptures: 100 });
    const cache = new DescriptionCache(100, 60000, null);
    const handoff = new VisionHandoff(makeConfig(), cache, null, undefined, db);

    // Patch callVisionRecorded (private, now on VisionImageProcessor) to throw
    // — simulates an unhandled rejection in the vision promise that processImage awaits.
    (
      handoff as unknown as {
        imageProcessor: { callVisionRecorded: () => Promise<never> };
      }
    ).imageProcessor.callVisionRecorded = async () => {
      throw new Error("test rejection");
    };

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

    // processBody uses Promise.allSettled internally so it won't throw;
    // the rejection is swallowed into a failurePlaceholder result.
    await handoff.processBody(body, "openai");

    // Give the async rejection + catch a tick to settle.
    await new Promise((r) => setTimeout(r, 50));

    const visionRows = db.listVisionCaptures(100);
    expect(visionRows.length).toBeGreaterThanOrEqual(1);
    const vc = visionRows[0];
    expect(vc.state).toBe("failed");
  });
});
