// Unit tests for src/vision/handoff.ts — processBodyCacheOnly stats.
// Verifies cache-only path: all hits stats correct, miss delegates to foreground.
// Folded from vision-cache-only-stats.test.ts + cache-parallel parts.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";
import { DescriptionCache } from "../../src/vision/cache.js";
import type { VisionConfig } from "../../src/vision/handoff.js";
import { VisionHandoff } from "../../src/vision/handoff.js";
import { PersistentDescriptionStore } from "../../src/vision/persistent-cache.js";

const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const BLUE_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC";
const GREEN_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNg+M8AAAICAQB7CYF4AAAAAElFTkSuQmCC";

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `vision-cache-only-unit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

function mockVisionServer(descriptions: string[]) {
  let idx = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      const desc = descriptions[idx] ?? "fallback";
      idx++;
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
  return server;
}

describe("processBodyCacheOnly stats on miss (V3)", () => {
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

  test("all images are cache hits -> stats.cacheHits correct, body changed", async () => {
    const images = [RED_PNG_B64, BLUE_PNG_B64];
    const visionServer = mockVisionServer(["Red pixel.", "Blue pixel."]);
    try {
      const configWarm = makeConfig({
        target: `http://127.0.0.1:${visionServer.port ?? 0}`,
        backgroundVision: false,
      });
      const handoffWarm = new VisionHandoff(configWarm, cache, null, undefined, db);
      await handoffWarm.processBody(makeAnthropicBody(...images), "anthropic");

      const config = makeConfig({
        target: `http://127.0.0.1:${visionServer.port ?? 0}`,
        backgroundVision: true,
      });
      const handoff = new VisionHandoff(config, cache, null, undefined, db);
      const body = makeAnthropicBody(...images);

      const result = await handoff.processBodyCacheOnly(body, "anthropic");

      expect(result.changed).toBe(true);
      expect(result.stats.cacheHits).toBe(2);
      expect(result.stats.visionCalls).toBe(0);
    } finally {
      visionServer.stop(true);
    }
  });

  test("any image is a cache miss -> foreground rewrite, all images processed", async () => {
    const visionServer = mockVisionServer(["Red pixel.", "Blue pixel.", "Green pixel."]);
    try {
      const configWarm = makeConfig({
        target: `http://127.0.0.1:${visionServer.port ?? 0}`,
        backgroundVision: false,
      });
      const handoffWarm = new VisionHandoff(configWarm, cache, null, undefined, db);
      await handoffWarm.processBody(makeAnthropicBody(RED_PNG_B64, BLUE_PNG_B64), "anthropic");

      const config = makeConfig({
        target: `http://127.0.0.1:${visionServer.port ?? 0}`,
        backgroundVision: true,
      });
      const handoff = new VisionHandoff(config, cache, null, undefined, db);
      const body = makeAnthropicBody(RED_PNG_B64, BLUE_PNG_B64, GREEN_PNG_B64);

      const result = await handoff.processBodyCacheOnly(body, "anthropic");

      expect(result.changed).toBe(true);
      expect(result.stats.visionCalls).toBeGreaterThanOrEqual(1);

      await new Promise((r) => setTimeout(r, 500));
    } finally {
      visionServer.stop(true);
    }
  });

  test("miss on first image -> foreground rewrite, changed: true", async () => {
    const visionServer = mockVisionServer(["Blue pixel.", "Red pixel."]);
    try {
      const configWarm = makeConfig({
        target: `http://127.0.0.1:${visionServer.port ?? 0}`,
        backgroundVision: false,
      });
      const handoffWarm = new VisionHandoff(configWarm, cache, null, undefined, db);
      await handoffWarm.processBody(makeAnthropicBody(BLUE_PNG_B64), "anthropic");

      const config = makeConfig({
        target: `http://127.0.0.1:${visionServer.port ?? 0}`,
        backgroundVision: true,
      });
      const handoff = new VisionHandoff(config, cache, null, undefined, db);
      const body = makeAnthropicBody(RED_PNG_B64, BLUE_PNG_B64);

      const result = await handoff.processBodyCacheOnly(body, "anthropic");

      expect(result.changed).toBe(true);
      expect(result.stats.visionCalls).toBeGreaterThanOrEqual(1);

      await new Promise((r) => setTimeout(r, 500));
    } finally {
      visionServer.stop(true);
    }
  });
});

describe("processBodyCacheOnly parallel hits (PERF-04 / Plan 004)", () => {
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

  test("multiple cache hits in one body do not trigger vision calls", async () => {
    const images = [RED_PNG_B64, BLUE_PNG_B64, GREEN_PNG_B64];
    const visionServer = mockVisionServer(["Red.", "Blue.", "Green."]);
    let visionCallCount = 0;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (...args: Parameters<typeof fetch>) => {
      const url = String(args[0]);
      if (url.includes(`127.0.0.1:${visionServer.port ?? 0}`)) {
        visionCallCount++;
      }
      return originalFetch(...args);
    }) as typeof fetch;

    try {
      const configWarm = makeConfig({
        target: `http://127.0.0.1:${visionServer.port ?? 0}`,
        backgroundVision: false,
      });
      const handoffWarm = new VisionHandoff(configWarm, cache, null, undefined, db);
      await handoffWarm.processBody(makeAnthropicBody(...images), "anthropic");

      visionCallCount = 0;

      const config = makeConfig({
        target: `http://127.0.0.1:${visionServer.port ?? 0}`,
        backgroundVision: true,
      });
      const handoff = new VisionHandoff(config, cache, null, undefined, db);
      const result = await handoff.processBodyCacheOnly(makeAnthropicBody(...images), "anthropic");

      expect(result.changed).toBe(true);
      expect(result.stats.cacheHits).toBe(3);
      expect(result.stats.visionCalls).toBe(0);
      expect(visionCallCount).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
      visionServer.stop(true);
    }
  });
});
