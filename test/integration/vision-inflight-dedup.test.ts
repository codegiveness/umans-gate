// Integration tests: inflight dedup TOCTOU fix.
// Uses direct VisionHandoff + mock server (no proxy needed, but
// integration-tier since it exercises real concurrency + transcode paths).
//
// Migrated from test/vision-inflight-dedup.test.ts (subprocess → direct in-process).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";
import { DescriptionCache } from "../../src/vision/cache.js";
import type { VisionConfig } from "../../src/vision/handoff.js";
import { VisionHandoff } from "../../src/vision/handoff.js";
import { PersistentDescriptionStore } from "../../src/vision/persistent-cache.js";
import { getTranscodeCallCount, resetTranscodeCallCount } from "../../src/vision/transcode.js";

const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `vision-inflight-ip-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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
    backgroundVision: false,
    ...overrides,
  };
}

function makeAnthropicBody(imageB64: string): unknown {
  return {
    model: "umans-glm-5.2",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: imageB64,
            },
          },
          { type: "text", text: "What do you see?" },
        ],
      },
    ],
  };
}

interface MockVisionServer {
  readonly port: number;
  stop: () => void;
  callCount: () => number;
  resetCallCount: () => void;
  setDelayMs: (ms: number) => void;
  setFailNext: (n: number) => void;
}

function startMockVisionServer(): MockVisionServer {
  let calls = 0;
  let delayMs = 50;
  let failNext = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      const idx = calls++;
      if (failNext > 0) {
        failNext--;
        return new Response("upstream error", { status: 500 });
      }
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      return Response.json({
        id: `chatcmpl-mock-${idx}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "umans-flash",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: `Red pixel image #${idx}.` },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    },
  });
  return {
    port: server.port!,
    stop: () => server.stop(true),
    callCount: () => calls,
    resetCallCount: () => {
      calls = 0;
    },
    setDelayMs: (ms: number) => {
      delayMs = ms;
    },
    setFailNext: (n: number) => {
      failNext = n;
    },
  };
}

describe("V4: inflight dedup TOCTOU fix (in-process)", () => {
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
  });

  test("two concurrent requests for same image → exactly ONE transcode + ONE vision call", async () => {
    const server = startMockVisionServer();
    server.setDelayMs(100);

    const config = makeConfig({
      target: `http://127.0.0.1:${server.port}`,
      backgroundVision: false,
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);
    const body = makeAnthropicBody(RED_PNG_B64);

    const [r1, r2] = await Promise.all([
      handoff.processBody(body, "anthropic"),
      handoff.processBody(body, "anthropic"),
    ]);

    expect(getTranscodeCallCount()).toBe(1);
    expect(server.callCount()).toBe(1);
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(true);
    expect(r1.stats.visionCalls + r2.stats.visionCalls).toBe(1);

    server.stop();
  });

  test("second request awaits the inflight promise and gets the same description", async () => {
    const server = startMockVisionServer();
    server.setDelayMs(100);

    const config = makeConfig({
      target: `http://127.0.0.1:${server.port}`,
      backgroundVision: false,
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);
    const body = makeAnthropicBody(RED_PNG_B64);

    const [r1, r2] = await Promise.all([
      handoff.processBody(body, "anthropic"),
      handoff.processBody(body, "anthropic"),
    ]);

    const extractDesc = (r: { body: unknown }): string => {
      const b = r.body as {
        messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      };
      const textPart = b.messages[0].content.find((p) => p.type === "text" && p.text);
      return textPart?.text ?? "";
    };
    const desc1 = extractDesc(r1);
    const desc2 = extractDesc(r2);

    expect(desc1).toContain("Red pixel image");
    expect(desc2).toContain("Red pixel image");
    expect(desc1).toBe(desc2);

    server.stop();
  });

  test("if first request's vision call fails, second gets failure placeholder", async () => {
    const server = startMockVisionServer();
    server.setDelayMs(100);
    server.setFailNext(1);

    const config = makeConfig({
      target: `http://127.0.0.1:${server.port}`,
      backgroundVision: false,
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);
    const body = makeAnthropicBody(RED_PNG_B64);

    const [r1, r2] = await Promise.all([
      handoff.processBody(body, "anthropic"),
      handoff.processBody(body, "anthropic"),
    ]);

    expect(server.callCount()).toBe(1);
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(true);

    const extractText = (r: { body: unknown }): string => {
      const b = r.body as {
        messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      };
      return b.messages[0].content.find((p) => p.type === "text" && p.text)?.text ?? "";
    };
    expect(extractText(r1).length).toBeGreaterThan(0);
    expect(extractText(r2).length).toBeGreaterThan(0);

    server.stop();
  });

  test("if first request's TRANSCODE fails, second gets failure placeholder", async () => {
    const invalidImageB64 = Buffer.from("not-an-image-at-all-just-random-bytes").toString("base64");

    const server = startMockVisionServer();
    server.setDelayMs(100);

    const config = makeConfig({
      target: `http://127.0.0.1:${server.port}`,
      backgroundVision: false,
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);
    const body = makeAnthropicBody(invalidImageB64);

    const [r1, r2] = await Promise.all([
      handoff.processBody(body, "anthropic"),
      handoff.processBody(body, "anthropic"),
    ]);

    expect(server.callCount()).toBe(0);
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(true);

    server.stop();
  });

  test("inflight entry is cleaned up after completion on ALL paths", async () => {
    const server = startMockVisionServer();
    server.setDelayMs(50);

    function getInflightSize(h: VisionHandoff): number {
      return (
        h as unknown as {
          imageProcessor: { inflight: Map<string, Promise<string>> };
        }
      ).imageProcessor.inflight.size;
    }

    {
      const cache2 = new DescriptionCache(100, 60_000, store);
      const config = makeConfig({
        target: `http://127.0.0.1:${server.port}`,
        backgroundVision: false,
      });
      const handoff = new VisionHandoff(config, cache2, null, undefined, db);
      const body = makeAnthropicBody(RED_PNG_B64);
      await handoff.processBody(body, "anthropic");
      expect(getInflightSize(handoff)).toBe(0);
    }

    {
      const dbPath2 = makeTmpDbPath();
      const db2 = new CaptureDB({ dbPath: dbPath2, maxCaptures: 100 });
      const store2 = new PersistentDescriptionStore(db2, 60_000, 100);
      const cache2 = new DescriptionCache(100, 60_000, store2);
      server.resetCallCount();
      server.setFailNext(1);
      server.setDelayMs(50);
      const config = makeConfig({
        target: `http://127.0.0.1:${server.port}`,
        backgroundVision: false,
      });
      const handoff = new VisionHandoff(config, cache2, null, undefined, db2);
      const body = makeAnthropicBody(RED_PNG_B64);
      await handoff.processBody(body, "anthropic");
      expect(getInflightSize(handoff)).toBe(0);
      store2.close();
      db2.close();
      try {
        unlinkSync(dbPath2);
      } catch {
        // ignore
      }
    }

    {
      const cache2 = new DescriptionCache(100, 60_000, store);
      const config = makeConfig({
        target: `http://127.0.0.1:${server.port}`,
        backgroundVision: false,
      });
      const handoff = new VisionHandoff(config, cache2, null, undefined, db);
      const invalidImageB64 = Buffer.from("not-an-image-at-all-just-random-bytes").toString(
        "base64",
      );
      const bodyInvalid = makeAnthropicBody(invalidImageB64);
      await handoff.processBody(bodyInvalid, "anthropic");
      expect(getInflightSize(handoff)).toBe(0);
    }

    server.stop();
  });
});
