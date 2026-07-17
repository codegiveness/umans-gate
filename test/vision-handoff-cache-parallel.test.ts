// TDD tests for PERF-04: parallelize vision cache-only checks.
// These tests verify that processBodyCacheOnly checks the cache from the
// original decoded bytes before any transcoding, fails fast on any miss,
// and never calls transcodeImage when all images are cache hits.
//
// Run: bun test test/vision-handoff-cache-parallel.test.ts

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../src/db.js";
import { DescriptionCache } from "../src/vision/cache.js";
import { type CompressionRecipe, imageCacheKey } from "../src/vision/cache.js";
import { VisionHandoff } from "../src/vision/handoff.js";
import type { VisionConfig } from "../src/vision/handoff.js";
import { PersistentDescriptionStore } from "../src/vision/persistent-cache.js";
import { getTranscodeCallCount, resetTranscodeCallCount } from "../src/vision/transcode.js";
import { failurePlaceholder, isFailurePlaceholder } from "../src/vision/wrapper.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** 1x1 red PNG (base64). */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

/** 1x1 blue PNG (base64). */
const BLUE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";

/** 1x1 green PNG (base64). */
const GREEN_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC";

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `vision-parallel-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
            source: {
              type: "base64",
              media_type: "image/png",
              data,
            },
          })),
          { type: "text", text: "What do you see?" },
        ],
      },
    ],
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("processBodyCacheOnly parallel behavior (PERF-04)", () => {
  let dbPath: string;
  let db: CaptureDB;
  let store: PersistentDescriptionStore;
  let cache: DescriptionCache;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = new CaptureDB({ dbPath, maxCaptures: 100 });
    store = new PersistentDescriptionStore(db, 60_000, 100);
    cache = new DescriptionCache(100, 60_000, store);
  });

  afterEach(() => {
    store.close();
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("multiple images, all cache hits → { changed: true }", async () => {
    // Phase 1: populate the cache by running a real processBody with a mock vision upstream.
    // We do this by warming the cache manually with the transcoded bytes.
    // But the simpler approach: use processBodyCacheOnly twice — first call populates
    // via background vision (which we intercept), second call is all-hit.

    // Instead of a full vision round-trip, we directly warm the cache by
    // calling processBody once with a mock vision upstream that returns descriptions.
    // Since that requires a real server, we use a simpler approach:
    // warm the cache by computing the key the same way the handoff does.

    // We use the VisionHandoff's own processBody with a mock vision upstream.
    const visionDescriptions = ["Red pixel image.", "Blue pixel image.", "Green pixel image."];
    const images = [RED_PNG_B64, BLUE_PNG_B64, GREEN_PNG_B64];

    // Start a mock vision upstream that returns descriptions in order.
    let visionCallIdx = 0;
    const visionServer = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = await req.json().catch(() => ({}));
        const desc = visionDescriptions[visionCallIdx] ?? "fallback";
        visionCallIdx++;
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            { index: 0, message: { role: "assistant", content: desc }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });

    const config = makeConfig({
      target: `http://127.0.0.1:${visionServer.port}`,
      backgroundVision: false, // synchronous so we can wait for cache population
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);

    // Phase 1: run processBody to populate the cache.
    const body = makeAnthropicBody(...images);
    const result1 = await handoff.processBody(body, "anthropic");
    expect(result1.changed).toBe(true);
    expect(result1.stats.visionCalls).toBe(3);
    expect(result1.stats.cacheHits).toBe(0);

    // Phase 2: now all images should be cache hits.
    const result2 = await handoff.processBodyCacheOnly(body, "anthropic");
    expect(result2.changed).toBe(true);
    expect(result2.stats.cacheHits).toBe(3);
    expect(result2.stats.cacheMisses).toBe(0);
    expect(result2.stats.visionCalls).toBe(0);

    // Verify the body was actually mutated (image blocks replaced with text).
    const mutated = result2.body as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const textBlocks = mutated.messages[0].content.filter((p) => p.type === "text" && p.text);
    // 3 image replacements + 1 original text part = 4 text blocks
    expect(textBlocks.length).toBeGreaterThanOrEqual(3);

    visionServer.stop(true);
  });

  test("multiple images, one miss → { changed: false } and vision enqueued", async () => {
    // Populate cache for only 2 of 3 images.
    const visionDescriptions = ["Red pixel.", "Blue pixel."];
    const images = [RED_PNG_B64, BLUE_PNG_B64, GREEN_PNG_B64];

    let visionCallIdx = 0;
    const visionServer = Bun.serve({
      port: 0,
      async fetch() {
        const desc = visionDescriptions[visionCallIdx] ?? "Green pixel.";
        visionCallIdx++;
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            { index: 0, message: { role: "assistant", content: desc }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });

    // Phase 1: process only the first 2 images to populate cache for them.
    const config1 = makeConfig({
      target: `http://127.0.0.1:${visionServer.port}`,
      backgroundVision: false,
    });
    const handoff1 = new VisionHandoff(config1, cache, null, undefined, db);
    const body2images = makeAnthropicBody(RED_PNG_B64, BLUE_PNG_B64);
    await handoff1.processBody(body2images, "anthropic");

    // Phase 2: process all 3 images via cacheOnly — third should miss.
    const config2 = makeConfig({
      target: `http://127.0.0.1:${visionServer.port}`,
      backgroundVision: true, // background enqueue on miss
    });
    const handoff2 = new VisionHandoff(config2, cache, null, undefined, db);
    const body3images = makeAnthropicBody(...images);

    const visionCallsBefore = visionCallIdx;
    const result = await handoff2.processBodyCacheOnly(body3images, "anthropic");

    // Should NOT have changed the body (one image missed).
    expect(result.changed).toBe(false);
    // V3: prior hits had no effect (body unchanged) → cacheHits reset to 0.
    expect(result.stats.cacheHits).toBe(0);

    // Background vision should have been enqueued — wait for it.
    // Give it time to process the miss.
    await new Promise((r) => setTimeout(r, 500));
    const visionCallsAfter = visionCallIdx;
    expect(visionCallsAfter).toBeGreaterThan(visionCallsBefore);

    visionServer.stop(true);
  });

  test("all misses → { changed: false }", async () => {
    const images = [RED_PNG_B64, BLUE_PNG_B64];

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
              message: { role: "assistant", content: "Some description." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });

    const config = makeConfig({
      target: `http://127.0.0.1:${visionServer.port}`,
      backgroundVision: true,
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);
    const body = makeAnthropicBody(...images);

    const result = await handoff.processBodyCacheOnly(body, "anthropic");

    expect(result.changed).toBe(false);
    expect(result.stats.cacheHits).toBe(0);
    expect(result.stats.cacheMisses).toBe(0); // cacheOnly doesn't count misses in stats

    // Wait for background processing.
    await new Promise((r) => setTimeout(r, 500));

    visionServer.stop(true);
  });

  test("one transcode throws → handled gracefully, { changed: false }", async () => {
    // Use an invalid base64 string that will cause transcode to fail.
    // decodeBase64 will return null for invalid data, which is handled.
    // But we need transcode to actually throw — use bytes that decode
    // but are not a valid image.
    const invalidImageB64 = Buffer.from("not-an-image-at-all-just-random-bytes").toString("base64");

    const validImages = [RED_PNG_B64, BLUE_PNG_B64];

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
              message: { role: "assistant", content: "A valid image." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });

    // First populate cache for the 2 valid images.
    const config1 = makeConfig({
      target: `http://127.0.0.1:${visionServer.port}`,
      backgroundVision: false,
    });
    const handoff1 = new VisionHandoff(config1, cache, null, undefined, db);
    const bodyValid = makeAnthropicBody(...validImages);
    await handoff1.processBody(bodyValid, "anthropic");

    // Now process all 3 (2 valid + 1 invalid) via cacheOnly.
    const config2 = makeConfig({
      target: `http://127.0.0.1:${visionServer.port}`,
      backgroundVision: true,
    });
    const handoff2 = new VisionHandoff(config2, cache, null, undefined, db);
    const bodyWithInvalid = makeAnthropicBody(RED_PNG_B64, BLUE_PNG_B64, invalidImageB64);

    const result = await handoff2.processBodyCacheOnly(bodyWithInvalid, "anthropic");

    // Should not have changed — transcode error on the invalid image.
    expect(result.changed).toBe(false);

    // Wait for background processing.
    await new Promise((r) => setTimeout(r, 500));

    visionServer.stop(true);
  });

  test("all cache hits do NOT call transcodeImage", async () => {
    const images = [RED_PNG_B64, BLUE_PNG_B64];
    const descriptions = ["Red pixel.", "Blue pixel."];

    let visionCallIdx = 0;
    const visionServer = Bun.serve({
      port: 0,
      async fetch() {
        const desc = descriptions[visionCallIdx] ?? "fallback";
        visionCallIdx++;
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: desc },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });

    const config = makeConfig({
      target: `http://127.0.0.1:${visionServer.port}`,
      backgroundVision: false,
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);
    const body = makeAnthropicBody(...images);

    // Phase 1: populate cache via processBody (transcodes + caches).
    const result1 = await handoff.processBody(body, "anthropic");
    expect(result1.changed).toBe(true);
    expect(result1.stats.visionCalls).toBe(2);

    // Phase 2: cache-only must NOT call transcodeImage.
    resetTranscodeCallCount();

    const result2 = await handoff.processBodyCacheOnly(body, "anthropic");

    expect(result2.changed).toBe(true);
    expect(result2.stats.cacheHits).toBe(2);
    expect(result2.stats.visionCalls).toBe(0);
    expect(getTranscodeCallCount()).toBe(0);

    visionServer.stop(true);
  });
});

// ── Plan 004: failure placeholders must not be cached ──────────────────────

describe("getOrCompute does not cache failure placeholders (Plan 004)", () => {
  let dbPath: string;
  let db: CaptureDB;
  let store: PersistentDescriptionStore;
  let cache: DescriptionCache;

  const recipe: CompressionRecipe = {
    format: "png",
    quality: 92,
    max_dimension: 2048,
  };
  const bytes = Buffer.from("plan-004-test-image");
  const modelId = "umans-flash";
  const promptVersion = 1;
  const encoderVersion = "bun-image-v3";

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = new CaptureDB({ dbPath, maxCaptures: 100 });
    store = new PersistentDescriptionStore(db, 60_000, 100);
    cache = new DescriptionCache(100, 60_000, store);
  });

  afterEach(() => {
    store.close();
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("failure placeholder is not written to LRU or persistent store", () => {
    const placeholder = failurePlaceholder("generic", "vision fetch failed");
    let computeCalls = 0;

    const result = cache.getOrCompute(
      bytes,
      recipe,
      encoderVersion,
      modelId,
      promptVersion,
      () => {
        computeCalls++;
        return placeholder;
      },
      (desc) => !isFailurePlaceholder(desc),
    );

    expect(result).toBe(placeholder);
    expect(computeCalls).toBe(1);
    expect(cache.size).toBe(0);
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(0);
    expect(cache.persistentStats.writes).toBe(0);
  });

  test("uncached placeholder causes re-computation on next lookup", () => {
    const placeholder = failurePlaceholder("http_status", "500");
    let computeCalls = 0;

    for (let i = 0; i < 3; i++) {
      cache.getOrCompute(
        bytes,
        recipe,
        encoderVersion,
        modelId,
        promptVersion,
        () => {
          computeCalls++;
          return placeholder;
        },
        (desc) => !isFailurePlaceholder(desc),
      );
    }

    expect(computeCalls).toBe(3);
    expect(cache.size).toBe(0);
  });

  test("successful description is cached normally", () => {
    const description = "A red pixel on a white background.";
    let computeCalls = 0;

    const r1 = cache.getOrCompute(
      bytes,
      recipe,
      encoderVersion,
      modelId,
      promptVersion,
      () => {
        computeCalls++;
        return description;
      },
      (desc) => !isFailurePlaceholder(desc),
    );

    const r2 = cache.getOrCompute(
      bytes,
      recipe,
      encoderVersion,
      modelId,
      promptVersion,
      () => {
        computeCalls++;
        return "should not be called";
      },
      (desc) => !isFailurePlaceholder(desc),
    );

    expect(r1).toBe(description);
    expect(r2).toBe(description);
    expect(computeCalls).toBe(1);
    expect(cache.size).toBe(1);
    expect(cache.stats.hits).toBe(1);
    expect(cache.persistentStats.writes).toBe(1);
  });

  test("end-to-end: vision failure is not cached, retry succeeds", async () => {
    const images = [RED_PNG_B64];

    let visionCallIdx = 0;
    const visionServer = Bun.serve({
      port: 0,
      async fetch() {
        visionCallIdx++;
        if (visionCallIdx === 1) {
          return new Response("upstream error", { status: 500 });
        }
        return Response.json({
          id: "chatcmpl-mock",
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "umans-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "A tiny red pixel." },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        });
      },
    });

    const config = makeConfig({
      target: `http://127.0.0.1:${visionServer.port}`,
      backgroundVision: false,
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);

    const body = makeAnthropicBody(...images);

    const result1 = await handoff.processBody(body, "anthropic");
    expect(result1.stats.visionCalls).toBe(1);
    expect(result1.stats.cacheHits).toBe(0);

    const desc1 = result1.body as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const text1 = desc1.messages[0].content.find((p) => p.type === "text" && p.text);
    expect(text1?.text).toBeTruthy();
    expect(text1!.text!).toContain("[Image analysis failed:");

    expect(cache.size).toBe(0);
    expect(cache.persistentStats.writes).toBe(0);

    const result2 = await handoff.processBody(body, "anthropic");
    expect(result2.stats.visionCalls).toBe(1);
    expect(result2.stats.cacheHits).toBe(0);

    const desc2 = result2.body as {
      messages: Array<{ content: Array<{ type: string; text?: string }> }>;
    };
    const text2 = desc2.messages[0].content.find((p) => p.type === "text" && p.text);
    expect(text2?.text).toBeTruthy();
    expect(text2!.text!).not.toContain("[Image analysis failed:");

    expect(cache.size).toBe(1);
    expect(cache.persistentStats.writes).toBe(1);

    visionServer.stop(true);
  });
});
