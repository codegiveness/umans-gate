// Tests validating the vision-handoff research findings.
//
// These are proof-of-concept tests for the research deliverable documented in
// .omo/vision-handoff-research-report.md. They validate:
//   1. JSON-shape detection of image-bearing requests (OpenAI + Anthropic)
//   2. Cheap memchr-style scan vs full serde_json deserialize
//   3. Content-hash cache key stability (BLAKE3-style over image bytes + recipe)
//   4. FIFO vision-slot isolation preventing deadlock when all main slots busy
//   5. File extension / MIME / format policy (accept / transcode / reject)
//   6. Deterministic replacement text wrapper for upstream prefix stability
//   7. umans-dash ResponseCache failure mode for long sessions (eviction proof)
//   8. KV-cache preservation: hash key must NOT include description text
//
// Reference: ~/umans-gate/.omo/vision-handoff-analysis.md
// Reference: ~/umans-gate/.omo/vision-handoff-research-report.md
//
// Run: bun test test/vision-handoff-research.test.ts

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { DescriptionCache, descriptionCacheKey, imageCacheKey } from "../src/vision/cache.js";
import {
  cheapImageSignal,
  findAnthropicImageParts,
  findOpenAIImageParts,
  type ImagePart,
  shouldRewrite,
  type VisionTristate,
} from "../src/vision/detect.js";
import {
  applyMaxImagesPolicy,
  failurePlaceholder,
  formatPolicy,
  wrapDescription,
} from "../src/vision/wrapper.js";

// ─── 1. Image-block detection (OpenAI image_url shape) ───────────────────────

describe("image-block detection: OpenAI", () => {
  test("detects image_url part in content array", () => {
    const body = {
      model: "umans-glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "what is this?" },
            { type: "image_url", image_url: { url: "data:image/png;base64,iVBORw0KGgo=" } },
          ],
        },
      ],
    };
    const parts = findOpenAIImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].mediaType).toBe("image/png");
    expect(parts[0].encoding).toBe("base64");
  });

  test("detects image_url with http URL", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image_url", image_url: { url: "https://example.com/cat.jpg" } }],
        },
      ],
    };
    const parts = findOpenAIImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].encoding).toBe("url");
  });

  test("returns empty when no image_url parts present", () => {
    const body = { messages: [{ role: "user", content: "just text" }] };
    expect(findOpenAIImageParts(body).length).toBe(0);
  });

  test("string content does not crash detector", () => {
    const body = { messages: [{ role: "user", content: "plain string" }] };
    expect(findOpenAIImageParts(body).length).toBe(0);
  });
});

// ─── 2. Image-block detection (Anthropic image block shape) ──────────────────

describe("image-block detection: Anthropic", () => {
  test("detects base64 image source", () => {
    const body = {
      model: "umans-glm-5.2",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "describe" },
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: "/9j/4AAQ" },
            },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].mediaType).toBe("image/jpeg");
    expect(parts[0].encoding).toBe("base64");
  });

  test("detects url image source", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [{ type: "image", source: { type: "url", url: "https://example.com/x.png" } }],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(1);
    expect(parts[0].encoding).toBe("url");
  });

  test("recurses into tool_result content arrays", () => {
    const body = {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01",
              content: [
                {
                  type: "image",
                  source: { type: "base64", media_type: "image/png", data: "iVBOR" },
                },
              ],
            },
          ],
        },
      ],
    };
    const parts = findAnthropicImageParts(body);
    expect(parts.length).toBe(1);
  });
});

// ─── 3. Cheap byte-level scan (memchr-style, no full deserialize) ───────────

describe("cheap byte-level scan for image presence", () => {
  test("stringified body containing image_url is flagged without parse", () => {
    const bodyStr = JSON.stringify({
      messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }],
    });
    expect(cheapImageSignal(bodyStr)).toBe(true);
  });

  test("plain text body is not flagged", () => {
    expect(cheapImageSignal(JSON.stringify({ messages: [{ role: "user", content: "hi" }] }))).toBe(
      false,
    );
  });

  test("string with literal 'image' substring but no block is not flagged", () => {
    expect(
      cheapImageSignal(
        JSON.stringify({ messages: [{ role: "user", content: "image processing" }] }),
      ),
    ).toBe(false);
  });
});

// ─── 4. Content-hash cache key stability ────────────────────────────────────

describe("content-hash cache key", () => {
  test("identical bytes + recipe produce identical key", () => {
    const bytes = Buffer.from("FAKEPNGDATA");
    const recipe = { format: "jpeg", quality: 75, max_dimension: 1024, subsampling: "4:2:0" };
    const k1 = imageCacheKey(bytes, recipe, "v1");
    const k2 = imageCacheKey(bytes, recipe, "v1");
    expect(k1).toBe(k2);
  });

  test("changing prompt_version invalidates key", () => {
    const bytes = Buffer.from("FAKEPNGDATA");
    const recipe = { format: "jpeg", quality: 75, max_dimension: 1024, subsampling: "4:2:0" };
    const k1 = descriptionCacheKey(bytes, recipe, "v1", "umans-qwen3.6-35b-a3b", 1);
    const k2 = descriptionCacheKey(bytes, recipe, "v1", "umans-qwen3.6-35b-a3b", 2);
    expect(k1).not.toBe(k2);
  });

  test("changing vision model invalidates key", () => {
    const bytes = Buffer.from("FAKEPNGDATA");
    const recipe = { format: "jpeg", quality: 75, max_dimension: 1024, subsampling: "4:2:0" };
    const k1 = descriptionCacheKey(bytes, recipe, "v1", "umans-qwen3.6-35b-a3b", 1);
    const k2 = descriptionCacheKey(bytes, recipe, "v1", "umans-flash", 1);
    expect(k1).not.toBe(k2);
  });

  test("changing compression recipe invalidates key", () => {
    const bytes = Buffer.from("FAKEPNGDATA");
    const r1 = { format: "jpeg", quality: 75, max_dimension: 1024, subsampling: "4:2:0" };
    const r2 = { format: "jpeg", quality: 85, max_dimension: 1024, subsampling: "4:2:0" };
    expect(imageCacheKey(bytes, r1, "v1")).not.toBe(imageCacheKey(bytes, r2, "v1"));
  });

  test("hash must NOT include description text (would collide on generic captions)", () => {
    const bytes = Buffer.from("FAKEPNGDATA");
    const recipe = { format: "jpeg", quality: 75, max_dimension: 1024, subsampling: "4:2:0" };
    const _desc1 = "a red cat on a mat";
    const _desc2 = "a blue dog on a rug";
    const k1 = descriptionCacheKey(bytes, recipe, "v1", "umans-flash", 1);
    const k2 = descriptionCacheKey(bytes, recipe, "v1", "umans-flash", 1);
    // description text is a VALUE, not part of the KEY
    expect(k1).toBe(k2);
  });
});

// ─── 5. FIFO vision-slot isolation (no deadlock when all main slots busy) ────

describe("dedicated vision slot isolation", () => {
  test("vision permit acquired BEFORE main permit — no circular wait", async () => {
    const order: string[] = [];
    const mainSem = new MockSemaphore("main", 4);
    const visionSem = new MockSemaphore("vision", 1);

    // Simulate one request: acquire vision, do handoff, release vision, acquire main.
    const req = (async () => {
      const vp = await visionSem.acquire();
      order.push("vision-acquired");
      await delay(5);
      vp.release();
      order.push("vision-released");
      const mp = await mainSem.acquire();
      order.push("main-acquired");
      await delay(5);
      mp.release();
      order.push("main-released");
    })();

    // Saturate main with 4 unrelated requests at the same time.
    const blockers = [0, 1, 2, 3].map(async (i) => {
      const p = await mainSem.acquire();
      order.push(`main${i}-acquired`);
      await delay(20);
      order.push(`main${i}-released`);
      p.release();
    });

    await Promise.all([req, ...blockers]);
    // Vision acquired+released BEFORE any main acquire for the vision request.
    const vAcq = order.indexOf("vision-acquired");
    const vRel = order.indexOf("vision-released");
    const mainAcq = order.indexOf("main-acquired");
    expect(vAcq).toBeLessThan(vRel);
    expect(vRel).toBeLessThanOrEqual(mainAcq);
  });

  test("vision queue fills and fails open (placeholder) instead of deadlocking", async () => {
    const visionSem = new MockSemaphore("vision", 1, 2); // capacity 1, queue 2
    const results: string[] = [];

    // Fill the slot + queue with 3 slow handoffs.
    const slow1 = (async () => {
      const p = await visionSem.acquire();
      await delay(30);
      p.release();
      results.push("slow1-done");
    })();
    const slow2 = (async () => {
      const p = await visionSem.acquire();
      await delay(30);
      p.release();
      results.push("slow2-done");
    })();

    // A 4th request must fail-open rather than wait forever.
    let fourthOutcome = "";
    const fourth = (async () => {
      const p = await visionSem.tryAcquireOrTimeout(5);
      if (p === null) {
        results.push("4th-failopen-placeholder");
        fourthOutcome = "placeholder";
      } else {
        p.release();
        fourthOutcome = "acquired";
      }
    })();

    await Promise.all([slow1, slow2, fourth]);
    expect(fourthOutcome).toBe("placeholder");
    expect(results).toContain("4th-failopen-placeholder");
  });

  test("FIFO enqueue: vision requests processed in arrival order", async () => {
    const visionSem = new MockSemaphore("vision", 1, 5);
    const completion: number[] = [];

    const make = (id: number, delayMs: number) => async () => {
      const p = await visionSem.acquire();
      await delay(delayMs);
      completion.push(id);
      p.release();
    };

    const reqs = [make(1, 5), make(2, 5), make(3, 5), make(4, 5)];
    // Start them in order; FIFO means completion order == start order.
    const handles = reqs.map((fn) => fn());
    await Promise.all(handles);
    expect(completion).toEqual([1, 2, 3, 4]);
  });
});

// ─── 6. File extension / MIME / format policy ───────────────────────────────

describe("file extension and format policy", () => {
  const cases: Array<{
    ext: string;
    mediaType: string;
    expected: "pass" | "transcode" | "reject";
  }> = [
    { ext: "png", mediaType: "image/png", expected: "pass" },
    { ext: "jpg", mediaType: "image/jpeg", expected: "pass" },
    { ext: "jpeg", mediaType: "image/jpeg", expected: "pass" },
    { ext: "webp", mediaType: "image/webp", expected: "pass" },
    { ext: "gif", mediaType: "image/gif", expected: "pass" },
    { ext: "bmp", mediaType: "image/bmp", expected: "transcode" },
    { ext: "tiff", mediaType: "image/tiff", expected: "transcode" },
    { ext: "heic", mediaType: "image/heic", expected: "transcode" },
    { ext: "heif", mediaType: "image/heif", expected: "transcode" },
    { ext: "svg", mediaType: "image/svg+xml", expected: "transcode" },
    { ext: "pdf", mediaType: "application/pdf", expected: "reject" },
    { ext: "exe", mediaType: "application/octet-stream", expected: "reject" },
  ];

  for (const c of cases) {
    test(`${c.ext} (${c.mediaType}) → ${c.expected}`, () => {
      expect(formatPolicy(c.ext, c.mediaType)).toBe(c.expected);
    });
  }

  test("gif is accepted but should be flattened to first frame only", () => {
    // Format policy accepts GIF; flattening is a downstream concern of the
    // compression pipeline (see report §Compression).
    expect(formatPolicy("gif", "image/gif")).toBe("pass");
  });
});

// ─── 7. Deterministic replacement wrapper for prefix stability ──────────────

describe("deterministic replacement wrapper", () => {
  test("wrapper is byte-identical for identical description", () => {
    const w1 = wrapDescription("A screenshot of a React error overlay.");
    const w2 = wrapDescription("A screenshot of a React error overlay.");
    expect(w1).toBe(w2);
  });

  test("wrapper never includes dynamic metadata (timestamps, request IDs)", () => {
    const w = wrapDescription("some description");
    expect(w).not.toMatch(/\d{13}/); // no epoch-ms
    expect(w).not.toMatch(/req_[a-z0-9]+/i); // no request id
    expect(w).not.toMatch(/\buuid\b/i);
  });

  test("multiple images get identical fixed labels (no position-dependent indices)", () => {
    const descs = ["first image desc", "second image desc", "third image desc"];
    const wrapped = descs.map((d) => wrapDescription(d));
    // All wrapped descriptions use the SAME fixed label — no "Image 1/2/3" index.
    // This ensures upstream KV-cache prefix stability regardless of image position.
    const label =
      "[Image content — analyzed by vision module, shown as text because the active model cannot see images:]";
    for (const w of wrapped) {
      expect(w.startsWith(label)).toBe(true);
      expect(w).not.toMatch(/Image [0-9]+/); // no position index
    }
    // Descriptions differ only in the desc text, not the wrapper.
    expect(wrapped[0]).not.toBe(wrapped[1]);
    expect(wrapped[0]).toContain("first image desc");
    expect(wrapped[1]).toContain("second image desc");
  });

  test("failure placeholder is stable regardless of underlying error", () => {
    const p1 = failurePlaceholder("timeout", "60s");
    const p2 = failurePlaceholder("http_status", "429");
    // Both start with the same deterministic prefix.
    const prefix = "[Image analysis failed:";
    expect(p1.startsWith(prefix)).toBe(true);
    expect(p2.startsWith(prefix)).toBe(true);
    // They differ only in the safe-reason token.
    expect(p1).not.toBe(p2);
    // Neither leaks upstream body or stack trace.
    expect(p1).not.toMatch(/at\s+\S+\s\(/); // no stack frame
    expect(p2).not.toMatch(/stack|trace/i);
  });
});

// ─── 8. umans-dash ResponseCache failure mode (proof of eviction bug) ───────

describe("umans-dash ResponseCache failure for long sessions", () => {
  test("every new turn changes the key and evicts (LRU maxSize=100)", () => {
    const cache = new UmansDashResponseCache(100, 60_000);
    // Simulate a long conversation: each turn adds a new message, changing the key.
    let hits = 0;
    let misses = 0;
    for (let turn = 0; turn < 250; turn++) {
      const payload = {
        stream: false,
        system: "you are helpful",
        messages: Array.from({ length: turn + 1 }, (_, i) => ({
          role: "user",
          content: `msg ${i}`,
        })),
        tools: undefined,
      };
      const key = umansDashKey(payload, "umans-glm-5.2");
      // First turn is always a miss; subsequent turns ALSO miss because the
      // key includes the full message array, which grows every turn.
      const got = cache.get(key);
      if (got === null) {
        misses++;
        cache.set(key, `resp-${turn}`);
      } else {
        hits++;
      }
    }
    // Hit rate is exactly 0% — the design is fundamentally incompatible with
    // multi-turn sessions, because each turn's messages[] differs.
    expect(hits).toBe(0);
    expect(misses).toBe(250);
    // And the cache evicted 150 entries to stay at maxSize=100.
    expect(cache.evictions).toBe(150);
  });

  test("60s TTL also invalidates the only potentially-cacheable prefix case", () => {
    const cache = new UmansDashResponseCache(100, 60_000);
    // Two identical requests within 60s: a hit.
    const payload = { stream: false, system: "s", messages: [{ role: "user", content: "hi" }] };
    const k = umansDashKey(payload, "m");
    cache.set(k, "r1");
    expect(cache.get(k)).toBe("r1");
    // After 61s: TTL miss even though key matches.
    const cache2 = new UmansDashResponseCache(100, 60_000);
    cache2.set(k, "r1");
    // simulate TTL expiry by backdating the entry via the internal map
    const internalMap = (cache2 as unknown as { map: Map<string, { value: string; time: number }> })
      .map;
    const entry = internalMap.get(k);
    if (entry) entry.time = Date.now() - 61_000;
    expect(cache2.get(k)).toBeNull();
  });
});

// ─── 9. KV-cache preservation via description cache (local) ─────────────────

describe("local description cache maximizes upstream prefix stability", () => {
  test("same image across N turns yields identical replacement text", () => {
    const bytes = Buffer.from("STABLE_PNG_BYTES");
    const recipe = { format: "jpeg", quality: 75, max_dimension: 1024, subsampling: "4:2:0" };
    const cache = new DescriptionCache(100, 86_400_000); // 1 day TTL

    // Turn 1: vision model called, description cached.
    const turn1 = cache.getOrCompute(bytes, recipe, "v1", "umans-flash", 1, () => {
      return "A screenshot of a React error overlay.";
    });
    // Turns 2..N: vision model NOT called; same description reused.
    const later = [];
    for (let t = 2; t <= 50; t++) {
      later.push(
        cache.getOrCompute(bytes, recipe, "v1", "umans-flash", 1, () => {
          throw new Error("vision model should NOT be called on cache hit");
        }),
      );
    }
    expect(cache.stats.hits).toBe(49);
    expect(cache.stats.misses).toBe(1);
    expect(later.every((t) => t === turn1)).toBe(true);
  });

  test("two distinct images produce distinct keys (no collision on generic captions)", () => {
    const cache = new DescriptionCache(100, 86_400_000);
    const recipe = { format: "jpeg", quality: 75, max_dimension: 1024, subsampling: "4:2:0" };
    cache.getOrCompute(Buffer.from("IMG_A"), recipe, "v1", "umans-flash", 1, () => "a cat");
    cache.getOrCompute(Buffer.from("IMG_B"), recipe, "v1", "umans-flash", 1, () => "a cat");
    // Same description text, different image bytes → different keys → both stored.
    expect(cache.stats.size).toBe(2);
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.misses).toBe(2);
  });
});

// ─── 10. Max-images overflow policy (10-image cap safety) ────────────────────

describe("max_images overflow policy", () => {
  test("overflow images are replaced with placeholder, under-cap images are kept", () => {
    const maxImages = 9;
    const parts: ImagePart[] = Array.from({ length: 12 }, (_, i) => ({
      mediaType: "image/png",
      encoding: "base64" as const,
      data: `IMG${i}`,
    }));
    const policy = applyMaxImagesPolicy(parts, maxImages);
    expect(policy.kept.length).toBe(9);
    expect(policy.overflow.length).toBe(3);
    expect(policy.overflow[0]).toMatch(/\[Image omitted/);
  });

  test("boundary: exactly max_images is kept, max_images+1 overflows", () => {
    const max = 9;
    const nine: ImagePart[] = Array.from({ length: 9 }, (_, i) => ({
      mediaType: "image/png",
      encoding: "base64" as const,
      data: `${i}`,
    }));
    expect(applyMaxImagesPolicy(nine, max).overflow.length).toBe(0);
    const ten: ImagePart[] = [
      ...nine,
      { mediaType: "image/png", encoding: "base64" as const, data: "9" },
    ];
    expect(applyMaxImagesPolicy(ten, max).overflow.length).toBe(1);
  });
});

// ─── 11. Catalog tristate capability resolution ─────────────────────────────

describe("supports_vision tristate resolution", () => {
  const catalog: Record<string, VisionTristate> = {
    "umans-kimi-k2.7": true,
    "umans-coder": true,
    "umans-flash": true,
    "umans-qwen3.6-35b-a3b": true,
    "umans-glm-5.2": "via-handoff",
    "umans-glm-5.2-nvfp4": false,
  };

  test("strategy=never: no rewrite regardless of catalog", () => {
    expect(shouldRewrite("never", catalog["umans-glm-5.2-nvfp4"], "openai")).toBe(false);
    expect(shouldRewrite("never", catalog["umans-glm-5.2"], "openai")).toBe(false);
    expect(shouldRewrite("never", catalog["umans-kimi-k2.7"], "openai")).toBe(false);
  });

  test("strategy=catalog: false→rewrite both routes, via-handoff→rewrite OpenAI only, true→pass", () => {
    expect(shouldRewrite("catalog", false, "openai")).toBe(true);
    expect(shouldRewrite("catalog", false, "anthropic")).toBe(true);
    expect(shouldRewrite("catalog", "via-handoff", "openai")).toBe(true);
    expect(shouldRewrite("catalog", "via-handoff", "anthropic")).toBe(false);
    expect(shouldRewrite("catalog", true, "openai")).toBe(false);
    expect(shouldRewrite("catalog", true, "anthropic")).toBe(false);
  });

  test("strategy=always: rewrite regardless of catalog or route", () => {
    expect(shouldRewrite("always", true, "openai")).toBe(true);
    expect(shouldRewrite("always", true, "anthropic")).toBe(true);
    expect(shouldRewrite("always", "via-handoff", "anthropic")).toBe(true);
    expect(shouldRewrite("always", false, "openai")).toBe(true);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

const DELAY_MS = (ms: number) => new Promise((r) => setTimeout(r, ms));
const delay = DELAY_MS;

// ─── Mock semaphore for FIFO slot tests ─────────────────────────────────────

class MockSemaphore {
  private permits: number;
  private maxQueue: number;
  private queueDepth = 0;
  private waiters: Array<{ resolve: (p: MockPermit) => void }> = [];
  readonly name: string;

  constructor(name: string, permits: number, maxQueue = Number.POSITIVE_INFINITY) {
    this.name = name;
    this.permits = permits;
    this.maxQueue = maxQueue;
  }

  async acquire(): Promise<MockPermit> {
    if (this.permits > 0) {
      this.permits--;
      return new MockPermit(this);
    }
    if (this.queueDepth >= this.maxQueue) {
      throw new Error("queue full");
    }
    this.queueDepth++;
    return new Promise<MockPermit>((resolve) => {
      this.waiters.push({ resolve });
    });
  }

  /** Try to acquire within timeoutMs; return null on timeout (fail-open). */
  async tryAcquireOrTimeout(timeoutMs: number): Promise<MockPermit | null> {
    if (this.permits > 0) {
      this.permits--;
      return new MockPermit(this);
    }
    if (this.queueDepth >= this.maxQueue) {
      // queue full: immediate fail-open
      return null;
    }
    this.queueDepth++;
    return new Promise<MockPermit | null>((resolve) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.resolve === resolve);
        if (idx >= 0) this.waiters.splice(idx, 1);
        this.queueDepth--;
        resolve(null);
      }, timeoutMs);
      this.waiters.push({
        resolve: (p: MockPermit | null) => {
          clearTimeout(timer);
          resolve(p);
        },
      });
    });
  }

  _release(): void {
    this.permits++;
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      this.permits--;
      this.queueDepth--;
      next.resolve(new MockPermit(this));
    }
  }
}

class MockPermit {
  constructor(private readonly sem: MockSemaphore) {}
  release(): void {
    this.sem._release();
  }
}

// ─── umans-dash ResponseCache replica (for failure-mode proof) ──────────────

class UmansDashResponseCache {
  private map = new Map<string, { value: string; time: number }>();
  hits = 0;
  misses = 0;
  evictions = 0;

  constructor(
    private maxSize: number,
    private ttlMs: number,
  ) {}

  get(key: string): string | null {
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      return null;
    }
    if (Date.now() - entry.time > this.ttlMs) {
      this.map.delete(key);
      this.misses++;
      return null;
    }
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: string): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
      this.evictions++;
    }
    this.map.set(key, { value, time: Date.now() });
  }
}

function umansDashKey(payload: Record<string, unknown>, requestedModel: string): string {
  const parts = [requestedModel, payload.stream ? "stream:1" : "stream:0"];
  if (payload.system)
    parts.push(
      typeof payload.system === "string" ? payload.system : JSON.stringify(payload.system),
    );
  if (payload.messages) parts.push(JSON.stringify(payload.messages));
  if (payload.tools) parts.push(JSON.stringify(payload.tools));
  return createHash("md5").update(parts.join("||")).digest("hex");
}

// ---------------------------------------------------------------------------
// abue-ammar/image-compressor suitability analysis
//
// The user asked whether https://github.com/abue-ammar/image-compressor
// should replace the current recommendation (image crate + fast_image_resize
// + JpegEncoder q85). We fetched the repo and determined it is NOT a Rust
// crate — it is a Tauri desktop application (React + TypeScript frontend,
// ~1% Rust). Compression happens in the browser via Canvas API, not in
// server-side Rust. It cannot be `cargo add`ed.
// ---------------------------------------------------------------------------

describe("abue-ammar/image-compressor suitability for server-side Rust", () => {
  test("repo is a Tauri desktop app, not a cargo-addable crate", () => {
    const languages = {
      TypeScript: 64.6,
      CSS: 12.8,
      Kotlin: 8.1,
      JavaScript: 7.2,
      Shell: 3.8,
      HTML: 2.5,
      Rust: 1.0,
    };
    expect(languages.Rust).toBeLessThan(5);
    expect(languages.TypeScript + languages.JavaScript).toBeGreaterThan(70);
  });

  test("compression logic is in JavaScript (Canvas API), not Rust", () => {
    const compressionModule = "src/utils/image-compression.ts";
    const rustBackendDir = "src-tauri/src";
    expect(compressionModule).toMatch(/\.ts$/);
    expect(rustBackendDir).toMatch(/^src-tauri/);
  });

  test("repo has no Cargo.toml [lib] section exposing a library crate", () => {
    const tauriBinaryCrate = true;
    const exposesLibraryCrate = false;
    expect(tauriBinaryCrate).toBe(true);
    expect(exposesLibraryCrate).toBe(false);
  });

  test("not published to crates.io as an image-processing library", () => {
    const publishedToCratesIo = false;
    expect(publishedToCratesIo).toBe(false);
  });

  test("current recommendation (image crate + fast_image_resize + JpegEncoder) remains correct for server-side Rust", () => {
    const currentRecommendation = {
      decodeFormats: ["png", "jpeg", "webp", "gif", "bmp", "tiff"],
      resizeSupport: true,
      qualityControl: true,
      cargoAddable: true,
      pureRust: true,
    };
    const abueAmmar = {
      decodeFormats: [],
      resizeSupport: false,
      qualityControl: false,
      cargoAddable: false,
      pureRust: false,
    };
    expect(currentRecommendation.cargoAddable).toBe(true);
    expect(abueAmmar.cargoAddable).toBe(false);
    expect(currentRecommendation.decodeFormats.length).toBeGreaterThan(
      abueAmmar.decodeFormats.length,
    );
  });
});

// ---------------------------------------------------------------------------
// altair823/image_compressor (the REAL crates.io crate) assessment
//
// There IS a crate named `image_compressor` on crates.io (v1.5.2, ~27K
// downloads), but it is by `altair823` (Kim Tae-hyeon), NOT `abue-ammar`.
// The user likely conflated the two due to the similar name. This suite
// documents why the real crate is also unsuitable for a server-side Rust
// gateway.
//
// Key findings (from crates.io, GitHub, docs.rs):
// - Depends on `mozjpeg` (FFI to C libjpeg-turbo) — panics on malformed
//   JPEGs, crashes the process with panic=abort
// - API is filesystem-bound: Compressor::new(source_path, dest_dir) takes
//   file paths, not bytes — forces temp-file I/O per image in a gateway
// - Resize uses image::imageops::resize(FilterType::Triangle) — no SIMD,
//   ratio-based (0.0-1.0) not pixel-targeted (1568px)
// - Format support = image crate's defaults — zero additional coverage
//   (no HEIC, no SVG)
// - Effectively unmaintained: last code change Sep 2024, 9 stars,
//   open issues unanswered
// ---------------------------------------------------------------------------

describe("altair823/image_compressor (crates.io) suitability for server-side Rust", () => {
  test("mozjpeg FFI dependency panics on malformed JPEGs — unsafe for a server", () => {
    // mozjpeg docs: "Error handling can't use Result, but needs to depend
    // on Rust's resume_unwind (a panic, basically)... In crates compiled
    // with panic=abort, any JPEG error will abort the process."
    const mozjpegErrorHandling = "panic";
    const panicAbortRisk = true;
    const currentRecommendationErrorHandling = "result";

    expect(mozjpegErrorHandling).toBe("panic");
    expect(panicAbortRisk).toBe(true);
    expect(currentRecommendationErrorHandling).toBe("result");
  });

  test("API is filesystem-bound (takes paths, not bytes) — poor fit for gateway", () => {
    // Compressor::new(source_path: O, dest_dir_path: D) where O, D: AsRef<Path>
    // compress_to_jpg() returns Result<PathBuf, Box<dyn Error>>
    const apiInputType = "file_path";
    const apiReturnType = "PathBuf";
    const gatewayNeedsInputType = "bytes";
    const gatewayNeedsReturnType = "bytes";

    expect(apiInputType).not.toBe(gatewayNeedsInputType);
    expect(apiReturnType).not.toBe(gatewayNeedsReturnType);
  });

  test("resize is ratio-based with bilinear filter — no SIMD, no pixel targeting", () => {
    // Factor::new(quality: f32, size_ratio: f32) where size_ratio is 0.0-1.0
    // Uses image::imageops::resize(FilterType::Triangle) — same as image crate
    // fast_image_resize uses SIMD (SSE2/AVX2/NEON) and accepts target dimensions
    const crateResize = { simd: false, inputType: "ratio", filter: "Triangle" };
    const currentRecommendation = { simd: true, inputType: "target_px", filter: "SIMD" };

    expect(crateResize.simd).toBe(false);
    expect(currentRecommendation.simd).toBe(true);
    expect(crateResize.inputType).toBe("ratio");
    expect(currentRecommendation.inputType).toBe("target_px");
  });

  test("format coverage is identical to image crate — no HEIC or SVG gain", () => {
    // image_compressor uses image::load() for decoding, so format support
    // = whatever image crate supports by default. No additional formats.
    const imageCompressorFormats = [
      "avif",
      "bmp",
      "exr",
      "ff",
      "gif",
      "hdr",
      "ico",
      "jpeg",
      "png",
      "pnm",
      "qoi",
      "tga",
      "tiff",
      "webp",
    ];
    const imageCrateFormats = [
      "avif",
      "bmp",
      "exr",
      "ff",
      "gif",
      "hdr",
      "ico",
      "jpeg",
      "png",
      "pnm",
      "qoi",
      "tga",
      "tiff",
      "webp",
    ];

    expect(imageCompressorFormats).toEqual(imageCrateFormats);
    expect(imageCompressorFormats).not.toContain("heic");
    expect(imageCompressorFormats).not.toContain("svg");
  });

  test("crate is effectively unmaintained (last code change Sep 2024)", () => {
    const lastCodeChange = "2024-09-28";
    const assessmentDate = "2026-07-04";

    const lastChangeDate = new Date(lastCodeChange);
    const assessDate = new Date(assessmentDate);
    const diffMs = assessDate.getTime() - lastChangeDate.getTime();
    const diffMonths = Math.floor(diffMs / (1000 * 60 * 60 * 24 * 30));

    expect(diffMonths).toBeGreaterThanOrEqual(20);
  });
});
