// TDD tests for V4: Fix inflight dedup TOCTOU gap using a deferred promise.
//
// The bug: processImage checks `this.inflight.get(cacheKey)` at line 578, finds
// nothing, then `await transcodeImage(decoded, ...)` at line 604 yields to the
// event loop. A second concurrent request for the same image also reaches line
// 578, finds nothing (the first hasn't set inflight yet), and starts its own
// transcode + vision call. The inflight.set only happens at line 677 — AFTER
// the transcode + vision call have both completed.
//
// The fix: create a deferred promise immediately after the inflight check
// returns empty (before the transcode await) and store it in the inflight map.
// Resolve it on ALL exit paths (transcode catch, vision success, vision failure).
//
// Run: bun test test/vision-inflight-dedup.test.ts

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../src/db.js";
import { DescriptionCache } from "../src/vision/cache.js";
import { VisionHandoff } from "../src/vision/handoff.js";
import type { VisionConfig } from "../src/vision/handoff.js";
import { PersistentDescriptionStore } from "../src/vision/persistent-cache.js";
import { getTranscodeCallCount, resetTranscodeCallCount } from "../src/vision/transcode.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** 1x1 red PNG (base64). */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `vision-inflight-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
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

/** Start a mock vision upstream. The handler delays by `delayMs` before
 * responding so concurrent callers overlap in the inflight window. */
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

// ── tests ───────────────────────────────────────────────────────────────────

describe("V4: inflight dedup TOCTOU fix", () => {
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
    server.setDelayMs(100); // slow vision so both requests overlap

    const config = makeConfig({
      target: `http://127.0.0.1:${server.port}`,
      backgroundVision: false,
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);
    const body = makeAnthropicBody(RED_PNG_B64);

    // Fire two concurrent processBody calls for the same image.
    const [r1, r2] = await Promise.all([
      handoff.processBody(body, "anthropic"),
      handoff.processBody(body, "anthropic"),
    ]);

    // Exactly one transcode (the dedup window is the transcode await).
    expect(getTranscodeCallCount()).toBe(1);
    // Exactly one vision call.
    expect(server.callCount()).toBe(1);

    // Both requests completed and produced descriptions.
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

    // Extract the description text from each result body.
    const extractDesc = (r: { body: unknown }): string => {
      const b = r.body as {
        messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      };
      const textPart = b.messages[0].content.find((p) => p.type === "text" && p.text);
      return textPart?.text ?? "";
    };
    const desc1 = extractDesc(r1);
    const desc2 = extractDesc(r2);

    // Both should contain the same vision-model-generated description
    // (not failure placeholders). One is the vision caller, the other is
    // the inflight awaiter — both must see the same stored description.
    expect(desc1).toContain("Red pixel image");
    expect(desc2).toContain("Red pixel image");
    expect(desc1).toBe(desc2);

    server.stop();
  });

  test("if first request's vision call fails, second gets failure (empty string from inflight)", async () => {
    const server = startMockVisionServer();
    server.setDelayMs(100);
    server.setFailNext(1); // first vision call returns 500

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

    // Exactly one vision call (the failure), the second awaited the inflight.
    expect(server.callCount()).toBe(1);

    // Both requests must complete (no hang). The inflight promise resolves
    // to "" on vision failure, so the awaiting request gets a failure
    // placeholder (wrapDescription("") is not used — the awaiter records
    // status "cache_hit" with desc "" and wraps it).
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(true);

    // The vision-caller gets a failure placeholder; the awaiter wraps "".
    // Both should be valid text blocks (no throw / no hang).
    const extractText = (r: { body: unknown }): string => {
      const b = r.body as {
        messages: Array<{ content: Array<{ type: string; text?: string }> }>;
      };
      return b.messages[0].content.find((p) => p.type === "text" && p.text)?.text ?? "";
    };
    // Both produce some text (failure placeholder or wrapped empty desc).
    expect(extractText(r1).length).toBeGreaterThan(0);
    expect(extractText(r2).length).toBeGreaterThan(0);

    server.stop();
  });

  test("if first request's TRANSCODE fails, second gets failure placeholder (not a hang)", async () => {
    // Use bytes that decode from base64 but fail to transcode (not a valid image).
    const invalidImageB64 = Buffer.from("not-an-image-at-all-just-random-bytes").toString("base64");

    const server = startMockVisionServer();
    server.setDelayMs(100);

    const config = makeConfig({
      target: `http://127.0.0.1:${server.port}`,
      backgroundVision: false,
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);
    const body = makeAnthropicBody(invalidImageB64);

    // Both must resolve (not hang) — the transcode-failure path must
    // resolve the inflight deferred promise before returning.
    const [r1, r2] = await Promise.all([
      handoff.processBody(body, "anthropic"),
      handoff.processBody(body, "anthropic"),
    ]);

    // Transcode was called exactly once (the second request hit the
    // inflight entry before reaching transcode, OR if the transcode threw
    // before the second's inflight check, the second still gets the
    // resolved-to-"" inflight promise). No vision call should happen.
    expect(server.callCount()).toBe(0);

    // Both complete with failure placeholders.
    expect(r1.changed).toBe(true);
    expect(r2.changed).toBe(true);

    server.stop();
  });

  test("inflight entry is cleaned up after completion on ALL paths", async () => {
    const server = startMockVisionServer();
    server.setDelayMs(50);

    // Access the private inflight map for inspection via a helper that
    // reads it off any handoff instance (they share the same class shape).
    function getInflightSize(h: VisionHandoff): number {
      return (h as unknown as { inflight: Map<string, Promise<string>> }).inflight.size;
    }

    // --- Success path ---
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

    // --- Vision failure path ---
    // Use a fresh store so the prior success's cached description does not
    // short-circuit into a cache hit (which would skip the inflight path).
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

    // --- Transcode failure path ---
    // A different image (invalid bytes) → different cache key, so no hit.
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
