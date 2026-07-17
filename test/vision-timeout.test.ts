// Regression test for V1: foreground vision fetch must enforce vision_timeout_ms.
//
// Before the fix, callVisionRecorded passed the caller's `signal` directly to
// both gate.acquire() and fetch() without any timeout. When vision_timeout_ms
// was > 0, the config was silently ignored — a hanging vision upstream would
// block the foreground path indefinitely.
//
// The fix combines the caller's `signal` with AbortSignal.timeout(timeoutMs)
// via AbortSignal.any() when timeoutMs > 0. A TimeoutError is surfaced as
// status: "timeout" (not "fetch_error" and not "aborted").

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../src/db.js";
import { DescriptionCache } from "../src/vision/cache.js";
import { type VisionConfig, VisionHandoff } from "../src/vision/handoff.js";
import { PersistentDescriptionStore } from "../src/vision/persistent-cache.js";

// ── helpers ──────────────────────────────────────────────────────────────────

/** 1x1 red PNG (base64). */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function makeTmpDbPath(): string {
  return join(tmpdir(), `vision-timeout-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

function makeOkResponse(desc: string): Response {
  return Response.json({
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "umans-flash",
    choices: [{ index: 0, message: { role: "assistant", content: desc }, finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  });
}

// ── tests ───────────────────────────────────────────────────────────────────

describe("V1: foreground vision fetch enforces vision_timeout_ms", () => {
  let dbPath: string;
  let db: CaptureDB;
  let store: PersistentDescriptionStore;
  let cache: DescriptionCache;
  let originalFetch: typeof fetch;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = new CaptureDB({ dbPath, maxCaptures: 100 });
    store = new PersistentDescriptionStore(db, 60_000, 100);
    cache = new DescriptionCache(100, 60_000, store);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    store.close();
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("timeoutMs=0 → no timeout (existing behavior preserved)", async () => {
    // A slow upstream that takes 300ms. With timeoutMs=0 it MUST succeed —
    // no timeout signal is attached.
    const slowServer = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((r) => setTimeout(r, 300));
        return makeOkResponse("A red pixel.");
      },
    });

    try {
      const config = makeConfig({
        target: `http://127.0.0.1:${slowServer.port}`,
        timeoutMs: 0,
      });
      const handoff = new VisionHandoff(config, cache, null, undefined, db);

      const result = await handoff.processBody(
        makeAnthropicBody(RED_PNG_B64),
        "anthropic",
        "umans-glm-5.2",
        1,
        undefined,
      );

      expect(result.changed).toBe(true);
      const records = handoff.getRecords();
      const visionRec = records.find((r) => r.status === "ok");
      expect(visionRec).toBeDefined();
      expect(visionRec?.status).toBe("ok");
    } finally {
      slowServer.stop(true);
    }
  });

  test("timeoutMs>0 → fetch aborts after timeout, returns status: timeout", async () => {
    // Slow upstream that delays well beyond the configured timeout.
    const slowServer = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((r) => setTimeout(r, 2000));
        return makeOkResponse("should not reach");
      },
    });

    try {
      const config = makeConfig({
        target: `http://127.0.0.1:${slowServer.port}`,
        timeoutMs: 100, // 100ms timeout — must abort the fetch
      });
      const handoff = new VisionHandoff(config, cache, null, undefined, db);

      const start = Date.now();
      const result = await handoff.processBody(
        makeAnthropicBody(RED_PNG_B64),
        "anthropic",
        "umans-glm-5.2",
        1,
        undefined,
      );
      const elapsed = Date.now() - start;

      expect(result.changed).toBe(true);
      const records = handoff.getRecords();
      const visionRec = records[0];
      // Status must be "timeout", NOT "fetch_error" and NOT "aborted".
      expect(visionRec?.status).toBe("timeout");
      // Must have aborted well before the slow upstream's 2000ms delay.
      expect(elapsed).toBeLessThan(1500);
    } finally {
      slowServer.stop(true);
    }
  });

  test("TimeoutError is NOT classified as fetch_error", async () => {
    // Mock fetch to throw a TimeoutError DOMException directly, simulating
    // AbortSignal.timeout() firing. Verifies the catch block classifies it
    // as "timeout" rather than falling through to "fetch_error".
    globalThis.fetch = (async () => {
      throw new DOMException("signal timed out", "TimeoutError");
    }) as unknown as typeof fetch;

    const config = makeConfig({
      target: "http://127.0.0.1:1",
      timeoutMs: 5000,
    });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);

    const result = await handoff.processBody(
      makeAnthropicBody(RED_PNG_B64),
      "anthropic",
      "umans-glm-5.2",
      1,
      undefined,
    );

    expect(result.changed).toBe(true);
    const records = handoff.getRecords();
    const visionRec = records[0];
    expect(visionRec?.status).toBe("timeout");
    expect(visionRec?.status).not.toBe("fetch_error");
    expect(visionRec?.status).not.toBe("aborted");
  });

  test("signal=undefined + timeoutMs>0 → no throw, timeout signal works alone", async () => {
    // Verifies AbortSignal.any([undefined, ...]) is NOT called — a bare
    // timeout signal must work even when the caller passes no signal.
    const slowServer = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((r) => setTimeout(r, 2000));
        return makeOkResponse("should not reach");
      },
    });

    try {
      const config = makeConfig({
        target: `http://127.0.0.1:${slowServer.port}`,
        timeoutMs: 100,
      });
      const handoff = new VisionHandoff(config, cache, null, undefined, db);

      // signal is explicitly undefined (the default from processBody when no
      // client signal is threaded). This MUST NOT throw and MUST abort via
      // the standalone timeout signal.
      const result = await handoff.processBody(
        makeAnthropicBody(RED_PNG_B64),
        "anthropic",
        "umans-glm-5.2",
        1,
        undefined,
      );

      expect(result.changed).toBe(true);
      const records = handoff.getRecords();
      const visionRec = records[0];
      expect(visionRec?.status).toBe("timeout");
    } finally {
      slowServer.stop(true);
    }
  });
});
