// Unit tests for src/vision/transcode.ts — byte-size guard + sequential transcode.
// Rewritten WITHOUT @ts-expect-error: uses transcode.ts test instrumentation
// (getTranscodeCallCount/resetTranscodeCallCount) instead of monkey-patching Bun.Image.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";
import { DescriptionCache } from "../../src/vision/cache.js";
import type { VisionConfig } from "../../src/vision/handoff.js";
import { VisionHandoff } from "../../src/vision/handoff.js";
import { PersistentDescriptionStore } from "../../src/vision/persistent-cache.js";
import {
  getTranscodeCallCount,
  resetTranscodeCallCount,
  TranscodeError,
  transcodeImage,
} from "../../src/vision/transcode.js";

const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

const TOO_LARGE_THRESHOLD = 25_000_000;

function decodeB64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64"));
}

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `vision-transcode-unit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
    backgroundVision: true,
    ...overrides,
  };
}

function makeAnthropicBody(...imagesB64: string[]): unknown {
  return {
    model: "umans-glm-5.2",
    messages: [
      {
        role: "user",
        content: [
          ...imagesB64.map((data) => ({
            type: "image",
            source: { type: "base64", media_type: "image/png", data },
          })),
          { type: "text", text: "What do you see?" },
        ],
      },
    ],
  };
}

describe("byte-size guard in transcodeImage", () => {
  test("image <= 25MB transcodes normally", async () => {
    const decoded = decodeB64(RED_PNG_B64);
    expect(decoded.byteLength).toBeLessThan(TOO_LARGE_THRESHOLD);
    const result = await transcodeImage(decoded, {
      maxDimension: 2048,
      quality: 92,
      format: "png",
    });
    expect(result.bytes.byteLength).toBeGreaterThan(0);
  });

  test("image > 25MB throws TranscodeError(too_large) before Bun.Image decode", async () => {
    const oversized = new Uint8Array(TOO_LARGE_THRESHOLD + 1);
    try {
      await transcodeImage(oversized, { maxDimension: 2048, quality: 92, format: "png" });
      expect.unreachable("should have thrown TranscodeError");
    } catch (err) {
      expect(err).toBeInstanceOf(TranscodeError);
      expect((err as TranscodeError).code).toBe("too_large");
      expect((err as Error).message).not.toContain("decode failed");
      expect((err as Error).message).not.toContain("encode failed");
    }
  });

  test("image exactly 25MB is allowed (boundary inclusive)", async () => {
    const exact = new Uint8Array(TOO_LARGE_THRESHOLD);
    try {
      await transcodeImage(exact, { maxDimension: 2048, quality: 92, format: "png" });
      expect.unreachable("random bytes should not decode");
    } catch (err) {
      if (err instanceof TranscodeError) {
        expect(err.code).not.toBe("too_large");
      } else {
        expect(err).toBeDefined();
      }
    }
  });
});

describe("transcodeImage test instrumentation", () => {
  test("getTranscodeCallCount/resetTranscodeCallCount track invocations", async () => {
    resetTranscodeCallCount();
    const decoded = decodeB64(RED_PNG_B64);
    await transcodeImage(decoded, { maxDimension: 2048, quality: 92, format: "png" });
    expect(getTranscodeCallCount()).toBe(1);
    await transcodeImage(decoded, { maxDimension: 2048, quality: 92, format: "png" });
    expect(getTranscodeCallCount()).toBe(2);
    resetTranscodeCallCount();
    expect(getTranscodeCallCount()).toBe(0);
  });
});

describe("processBody processes all images (sequential via concurrency=1)", () => {
  let dbPath: string;
  let db: CaptureDB;
  let store: PersistentDescriptionStore;
  let cache: DescriptionCache;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = new CaptureDB({ dbPath, maxCaptures: 100 });
    store = new PersistentDescriptionStore(db, 60_000, 100);
    cache = new DescriptionCache(100, 60_000, store);
    resetTranscodeCallCount();
  });

  afterEach(() => {
    store.close();
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
    resetTranscodeCallCount();
  });

  test("5 images all transcoded and vision-called (concurrency=1 serializes)", async () => {
    const imageCount = 5;
    const images = Array.from({ length: imageCount }, () => RED_PNG_B64);
    const body = makeAnthropicBody(...images);

    const originalFetch = globalThis.fetch;
    let fetchCallCount = 0;
    globalThis.fetch = mock(async () => {
      fetchCallCount++;
      return new Response(JSON.stringify({ content: [{ text: "desc" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as never;

    try {
      const handoff = new VisionHandoff(makeConfig(), cache, null, undefined, db);
      await handoff.processBody(body, "anthropic", "umans-glm-5.2", undefined, undefined);
      expect(fetchCallCount).toBe(imageCount);
      expect(getTranscodeCallCount()).toBe(imageCount);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
