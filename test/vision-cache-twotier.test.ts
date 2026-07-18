// Two-tier description cache: context-keyed + image-only fallback.
//
// Validates that DescriptionCache supports a context-aware vision handoff:
//   1. Context-tier hit (same image + same contextHash) — fast path.
//   2. Context-tier miss + image-only hit (first sight without context, then
//      a later sighting WITH context reuses the image-only description).
//   3. Both tiers miss → compute → dual-write (context tier + image-only tier).
//   4. Backward compatibility: descriptionCacheKey without contextHash produces
//      the exact same key as the legacy signature.
//   5. getOrCompute without contextHash behaves exactly as before (single-tier).
//   6. getImageOnly returns null when nothing is stored.
//   7. storeDual writes to both tiers.
//   8. Persistent store: storeDual writes to SQLite; getImageOnly reads from
//      SQLite on memory miss.
//
// Run: bun test test/vision-cache-twotier.test.ts

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../src/db.js";
import { DescriptionCache, descriptionCacheKey, imageCacheKey } from "../src/vision/cache.js";
import { PersistentDescriptionStore } from "../src/vision/persistent-cache.js";

// ── helpers ──────────────────────────────────────────────────────────────────

const RECIPE = { format: "jpeg", quality: 92, max_dimension: 2048 };
const ENCODER = "v1";
const MODEL = "umans-flash";
const PV = 1;
const BYTES = Buffer.from("FAKE_PNG_BYTES_FOR_TWOTIER_TEST");
const CONTEXT_A = "ctx-hash-conversation-about-cats";
const CONTEXT_B = "ctx-hash-conversation-about-dogs";

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `vision-cache-twotier-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

/** Reference implementation of the legacy (pre-contextHash) key, used to assert byte-identical output. */
function legacyKey(
  bytes: Buffer | Uint8Array,
  recipe: typeof RECIPE,
  encoderVersion: string,
  modelId: string,
  promptVersion: number,
): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(bytes);
  h.update(JSON.stringify(recipe));
  h.update(encoderVersion);
  const base = h.digest("hex");
  const h2 = new Bun.CryptoHasher("sha256");
  h2.update(base);
  h2.update(`|pv=${promptVersion}|model=${modelId}`);
  return h2.digest("hex");
}

// ── 1. Context-tier hit ──────────────────────────────────────────────────────

describe("two-tier cache: context-tier hit", () => {
  test("store with contextHash, lookup with same contextHash → HIT, hits++", () => {
    const cache = new DescriptionCache(100, 60_000);
    cache.storeDual(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_A, "a red cat");

    const before = cache.stats.hits;
    const result = cache.getOrCompute(
      BYTES,
      RECIPE,
      ENCODER,
      MODEL,
      PV,
      () => {
        throw new Error("compute should NOT be called on a cache hit");
      },
      undefined,
      CONTEXT_A,
    );

    expect(result).toBe("a red cat");
    expect(cache.stats.hits).toBe(before + 1);
  });
});

// ── 2. Context miss + image-only hit ────────────────────────────────────────

describe("two-tier cache: context miss + image-only hit", () => {
  test("store WITHOUT context first, lookup WITH contextHash → image-only HIT", () => {
    const cache = new DescriptionCache(100, 60_000);
    // Simulate the first sighting: no context, single-tier store.
    cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "a red cat");

    // Second sighting: same image, different context. The context tier should
    // miss but the image-only tier should hit.
    const before = cache.stats.hits;
    const result = cache.getOrCompute(
      BYTES,
      RECIPE,
      ENCODER,
      MODEL,
      PV,
      () => {
        throw new Error("compute should NOT be called on image-only hit");
      },
      undefined,
      CONTEXT_A,
    );

    expect(result).toBe("a red cat");
    expect(cache.stats.hits).toBe(before + 1);
  });

  test("image-only hit promotes to context tier (next lookup with same ctx is direct hit)", () => {
    const cache = new DescriptionCache(100, 60_000);
    cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "a red cat");

    // First lookup with context: image-only hit, promote.
    cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "unexpected", undefined, CONTEXT_A);

    // Second lookup with same context: should be a direct context-tier hit.
    const hitsBefore = cache.stats.hits;
    const result = cache.getOrCompute(
      BYTES,
      RECIPE,
      ENCODER,
      MODEL,
      PV,
      () => {
        throw new Error("compute should NOT be called after promotion");
      },
      undefined,
      CONTEXT_A,
    );
    expect(result).toBe("a red cat");
    expect(cache.stats.hits).toBe(hitsBefore + 1);
  });
});

// ── 3. Both miss → compute → dual-write ──────────────────────────────────────

describe("two-tier cache: both miss → compute → dual-write", () => {
  test("lookup with contextHash, both tiers miss, compute returns value, both tiers populated", () => {
    const cache = new DescriptionCache(100, 60_000);
    const before = cache.stats.misses;

    const result = cache.getOrCompute(
      BYTES,
      RECIPE,
      ENCODER,
      MODEL,
      PV,
      () => "freshly computed description",
      undefined,
      CONTEXT_A,
    );

    expect(result).toBe("freshly computed description");
    expect(cache.stats.misses).toBe(before + 1);

    // Lookup with context → HIT (context tier populated).
    const ctxHit = cache.getOrCompute(
      BYTES,
      RECIPE,
      ENCODER,
      MODEL,
      PV,
      () => {
        throw new Error("context tier should hit after dual-write");
      },
      undefined,
      CONTEXT_A,
    );
    expect(ctxHit).toBe("freshly computed description");

    // Lookup without context → HIT (image-only tier populated).
    const imgHit = cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => {
      throw new Error("image-only tier should hit after dual-write");
    });
    expect(imgHit).toBe("freshly computed description");
  });
});

// ── 4. Backward compatibility: descriptionCacheKey ──────────────────────────

describe("descriptionCacheKey backward compatibility", () => {
  test("no contextHash → byte-identical to legacy key", () => {
    const legacy = legacyKey(BYTES, RECIPE, ENCODER, MODEL, PV);
    const modern = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV);
    expect(modern).toBe(legacy);
  });

  test("with contextHash → DIFFERENT key from legacy (no collision)", () => {
    const legacy = legacyKey(BYTES, RECIPE, ENCODER, MODEL, PV);
    const withCtx = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_A);
    expect(withCtx).not.toBe(legacy);
  });

  test("different contextHashes produce different keys", () => {
    const a = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_A);
    const b = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_B);
    expect(a).not.toBe(b);
  });

  test("empty-string contextHash is treated as absent (backward compat)", () => {
    // An empty contextHash is falsy → the `if (contextHash)` branch is skipped.
    const empty = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV, "");
    const absent = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV);
    expect(empty).toBe(absent);
  });
});

// ── 5. getOrCompute backward compat (no contextHash) ─────────────────────────

describe("getOrCompute backward compatibility (no contextHash)", () => {
  test("without contextHash, behaves as single-tier cache", () => {
    const cache = new DescriptionCache(100, 60_000);
    // First call: miss → compute → store.
    const r1 = cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "desc-1");
    expect(r1).toBe("desc-1");
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(0);

    // Second call: hit (single tier).
    const r2 = cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "desc-2");
    expect(r2).toBe("desc-1");
    expect(cache.stats.hits).toBe(1);
  });

  test("without contextHash, isCacheable=false prevents caching (placeholder retry)", () => {
    const cache = new DescriptionCache(100, 60_000);
    // First call: compute returns a placeholder; isCacheable=false → not stored.
    const r1 = cache.getOrCompute(
      BYTES,
      RECIPE,
      ENCODER,
      MODEL,
      PV,
      () => "[Image analysis failed: timeout]",
      (v) => !v.startsWith("[Image analysis failed:"),
    );
    expect(r1).toBe("[Image analysis failed: timeout]");
    expect(cache.stats.misses).toBe(1);
    expect(cache.size).toBe(0);

    // Second call: should re-compute (not cached).
    const r2 = cache.getOrCompute(
      BYTES,
      RECIPE,
      ENCODER,
      MODEL,
      PV,
      () => "real description after retry",
      (v) => !v.startsWith("[Image analysis failed:"),
    );
    expect(r2).toBe("real description after retry");
    expect(cache.stats.misses).toBe(2);
  });
});

// ── 6. getImageOnly returns null when nothing stored ─────────────────────────

describe("getImageOnly null on empty", () => {
  test("returns null when neither tier has an entry", () => {
    const cache = new DescriptionCache(100, 60_000);
    const result = cache.getImageOnly(BYTES, RECIPE, ENCODER, MODEL, PV);
    expect(result).toBeNull();
  });
});

// ── 7. storeDual writes to both tiers ────────────────────────────────────────

describe("storeDual writes to both tiers", () => {
  test("after storeDual, getImageOnly returns the description (image tier)", () => {
    const cache = new DescriptionCache(100, 60_000);
    cache.storeDual(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_A, "dual-stored desc");
    expect(cache.getImageOnly(BYTES, RECIPE, ENCODER, MODEL, PV)).toBe("dual-stored desc");
  });

  test("after storeDual, context-tier lookup returns the description", () => {
    const cache = new DescriptionCache(100, 60_000);
    cache.storeDual(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_A, "dual-stored desc");
    const result = cache.getOrCompute(
      BYTES,
      RECIPE,
      ENCODER,
      MODEL,
      PV,
      () => {
        throw new Error("context tier should hit after storeDual");
      },
      undefined,
      CONTEXT_A,
    );
    expect(result).toBe("dual-stored desc");
  });

  test("storeDual writes 2 entries (size reflects dual write)", () => {
    const cache = new DescriptionCache(100, 60_000);
    const sizeBefore = cache.size;
    cache.storeDual(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_A, "dual-stored desc");
    expect(cache.size).toBe(sizeBefore + 2);
  });
});

// ── 8. Persistent store integration ─────────────────────────────────────────

describe("persistent store integration", () => {
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

  test("storeDual writes to persistent store; getImageOnly reads from SQLite on memory miss", () => {
    cache.storeDual(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_A, "persisted dual desc");

    // Flush the write-behind queue so SQLite actually has the row.
    store.flushNow();

    // Build a fresh cache over the SAME persistent store but with an empty
    // in-memory LRU — simulates a restart where memory is cold.
    const coldCache = new DescriptionCache(100, 60_000, store);

    // getImageOnly should miss memory and hit SQLite.
    const result = coldCache.getImageOnly(BYTES, RECIPE, ENCODER, MODEL, PV);
    expect(result).toBe("persisted dual desc");
  });

  test("getOrCompute with contextHash falls back to image-only tier in SQLite", () => {
    // Store without context first (legacy single-tier write → image-only key).
    cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "image-only persisted");
    store.flushNow();

    // Cold cache: memory empty, persistent store warm.
    const coldCache = new DescriptionCache(100, 60_000, store);

    // Lookup WITH contextHash: memory miss (both tiers), image-only hit in SQLite.
    const result = coldCache.getOrCompute(
      BYTES,
      RECIPE,
      ENCODER,
      MODEL,
      PV,
      () => {
        throw new Error("should hit image-only tier in SQLite, not compute");
      },
      undefined,
      CONTEXT_A,
    );
    expect(result).toBe("image-only persisted");
  });

  test("idx_vision_desc_image_hash index exists after CaptureDB init (idempotent)", () => {
    // The index is created in db.ts schema init. Verify it exists.
    const indexes = db.rawDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='vision_descriptions'",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_vision_desc_image_hash");
    expect(names).toContain("idx_vision_desc_last_accessed");
  });

  test("running CaptureDB init twice is idempotent (CREATE INDEX IF NOT EXISTS)", () => {
    // Reopening the DB on the same path should not error on the index creation.
    store.close();
    db.close();
    const db2 = new CaptureDB({ dbPath, maxCaptures: 100 });
    const indexes = db2.rawDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='vision_descriptions'",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_vision_desc_image_hash");
    db2.close();
  });
});

// ── 9. imageCacheKey unchanged (sanity) ──────────────────────────────────────

describe("imageCacheKey sanity", () => {
  test("stable for identical inputs", () => {
    const k1 = imageCacheKey(BYTES, RECIPE, ENCODER);
    const k2 = imageCacheKey(BYTES, RECIPE, ENCODER);
    expect(k1).toBe(k2);
  });
});
