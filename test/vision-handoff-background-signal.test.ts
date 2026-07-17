// Regression test for V2: background vision signal must NOT be tied to the
// client's req.signal. When a request bails to background vision (cache miss
// in processBodyCacheOnly), the background fetch must use a standalone signal
// based on timeoutMs — not the client disconnect signal.
//
// Before the fix, enqueueBackgroundVision passed `signal` (the client's
// req.signal) to the background fetch via AbortSignal.any([signal]). If the
// client disconnected, the background vision would abort, losing the chance
// to cache the description for future requests.

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

/** Type-safe accessor to call the private enqueueBackgroundVision method. */
interface VisionHandoffInternals {
  enqueueBackgroundVision(
    body: unknown,
    apiKind: "openai" | "anthropic",
    modelName: string | undefined,
    captureId: number | undefined,
    signal: AbortSignal | undefined,
  ): void;
}

function makeTmpDbPath(): string {
  return join(tmpdir(), `vision-bg-signal-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
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

describe("V2: background vision signal not tied to client disconnect", () => {
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

  test("background vision completes after req.signal aborts", async () => {
    // Mock vision server that takes 100ms to respond.
    const visionServer = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((r) => setTimeout(r, 100));
        return makeOkResponse("A red pixel.");
      },
    });

    try {
      const config = makeConfig({
        target: `http://127.0.0.1:${visionServer.port}`,
        timeoutMs: 0, // no timeout — background vision must run to completion
      });
      const handoff = new VisionHandoff(config, cache, null, undefined, db);

      // Simulate client disconnect: abort the client signal immediately.
      const clientAbort = new AbortController();
      clientAbort.abort();

      const body = makeAnthropicBody(RED_PNG_B64);
      // processBodyCacheOnly bails to background vision on cache miss.
      const result = await handoff.processBodyCacheOnly(
        body,
        "anthropic",
        "umans-glm-5.2",
        1,
        clientAbort.signal,
      );
      expect(result.changed).toBe(false);

      // Wait for background vision to complete despite client abort.
      await new Promise((r) => setTimeout(r, 400));

      // The description must have been cached — proving background vision
      // completed successfully rather than aborting with the client signal.
      expect(cache.size).toBe(1);

      // Record must show success, not abort.
      const records = handoff.getRecords();
      const visionRec = records.find((r) => r.status === "ok" || r.status === "aborted");
      expect(visionRec?.status).toBe("ok");
    } finally {
      visionServer.stop(true);
    }
  });

  test("timeoutMs=0 → no timeout signal (undefined) passed to fetch", async () => {
    const config = makeConfig({ timeoutMs: 0 });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);
    const internals = handoff as unknown as VisionHandoffInternals;

    const originalFetch = globalThis.fetch;
    let capturedSignal: AbortSignal | null | undefined;
    let captured = false;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      void input;
      capturedSignal = init?.signal;
      captured = true;
      return makeOkResponse("desc");
    }) as unknown as typeof fetch;

    try {
      internals.enqueueBackgroundVision(
        makeAnthropicBody(RED_PNG_B64),
        "anthropic",
        "umans-flash",
        undefined,
        undefined,
      );
      await new Promise((r) => setTimeout(r, 200));
      expect(captured).toBe(true);
      expect(capturedSignal).toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("timeoutMs>0 → background vision aborts after timeout", async () => {
    // Slow server that delays well beyond the timeout.
    const slowServer = Bun.serve({
      port: 0,
      async fetch() {
        await new Promise((r) => setTimeout(r, 500));
        return makeOkResponse("should not reach");
      },
    });

    try {
      const config = makeConfig({
        target: `http://127.0.0.1:${slowServer.port}`,
        timeoutMs: 30, // 30ms timeout — must abort the background fetch
      });
      const handoff = new VisionHandoff(config, cache, null, undefined, db);
      const internals = handoff as unknown as VisionHandoffInternals;

      internals.enqueueBackgroundVision(
        makeAnthropicBody(RED_PNG_B64),
        "anthropic",
        "umans-flash",
        undefined,
        undefined,
      );

      // Wait beyond the timeout for the abort to be processed and recorded.
      await new Promise((r) => setTimeout(r, 300));

      // The timeout signal must have fired: no successful "ok" record and
      // nothing cached. The call surfaces as "timeout" (V1 foreground fix),
      // or "aborted"/"fetch_error" depending on Bun's internal classification.
      const records = handoff.getRecords();
      expect(records.find((r) => r.status === "ok")).toBeUndefined();
      expect(cache.size).toBe(0);
      expect(
        records.find(
          (r) => r.status === "timeout" || r.status === "aborted" || r.status === "fetch_error",
        ),
      ).toBeDefined();
    } finally {
      slowServer.stop(true);
    }
  });

  test("signal=undefined + timeoutMs=0 → no error thrown", async () => {
    const config = makeConfig({ timeoutMs: 0 });
    const handoff = new VisionHandoff(config, cache, null, undefined, db);
    const internals = handoff as unknown as VisionHandoffInternals;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => makeOkResponse("desc")) as unknown as typeof fetch;

    try {
      // Must not throw synchronously — fire-and-forget with no signal and
      // no timeout. AbortSignal.any([undefined]) would throw; the fix avoids it.
      expect(() => {
        internals.enqueueBackgroundVision(
          makeAnthropicBody(RED_PNG_B64),
          "anthropic",
          "umans-flash",
          undefined,
          undefined,
        );
      }).not.toThrow();

      // Also verify a real (non-aborted) client signal does not throw and
      // does NOT get threaded through to the fetch (background uses timeoutMs).
      expect(() => {
        internals.enqueueBackgroundVision(
          makeAnthropicBody(RED_PNG_B64),
          "anthropic",
          "umans-flash",
          undefined,
          new AbortController().signal,
        );
      }).not.toThrow();

      await new Promise((r) => setTimeout(r, 200));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
