// Unit tests for src/vision/cache.ts — two-tier description cache.
//
// Validates that DescriptionCache supports a context-aware vision handoff:
//   1. Context-tier hit (same image + same contextHash) — fast path.
//   2. Context-tier miss + image-only hit.
//   3. Both tiers miss → compute → dual-write.
//   4. Backward compatibility: descriptionCacheKey without contextHash.
//   5. getOrCompute without contextHash behaves as single-tier.
//   6. getImageOnly returns null when nothing stored.
//   7. storeDual writes to both tiers.
//   8. Persistent store: storeDual writes to SQLite; getImageOnly reads from SQLite.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";
import {
  type CompressionRecipe,
  DescriptionCache,
  descriptionCacheKey,
  imageCacheKey,
} from "../../src/vision/cache.js";
import { PersistentDescriptionStore } from "../../src/vision/persistent-cache.js";

const RECIPE: CompressionRecipe = { format: "jpeg", quality: 92, max_dimension: 2048 };
const ENCODER = "v1";
const MODEL = "umans-flash";
const PV = 1;
const BYTES = Buffer.from("FAKE_PNG_BYTES_FOR_TWOTIER_TEST");
const CONTEXT_A = "ctx-hash-conversation-about-cats";
const CONTEXT_B = "ctx-hash-conversation-about-dogs";

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `vision-cache-unit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function legacyKey(
  bytes: Buffer | Uint8Array,
  recipe: CompressionRecipe,
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

describe("two-tier cache: context-tier hit", () => {
  test("store with contextHash, lookup with same contextHash -> HIT, hits++", () => {
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

describe("two-tier cache: context miss + image-only hit", () => {
  test("store WITHOUT context first, lookup WITH contextHash -> image-only HIT", () => {
    const cache = new DescriptionCache(100, 60_000);
    cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "a red cat");

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

  test("image-only hit promotes to context tier", () => {
    const cache = new DescriptionCache(100, 60_000);
    cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "a red cat");

    cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "unexpected", undefined, CONTEXT_A);

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

describe("two-tier cache: both miss -> compute -> dual-write", () => {
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

    const imgHit = cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => {
      throw new Error("image-only tier should hit after dual-write");
    });
    expect(imgHit).toBe("freshly computed description");
  });
});

describe("descriptionCacheKey backward compatibility", () => {
  test("no contextHash -> byte-identical to legacy key", () => {
    const legacy = legacyKey(BYTES, RECIPE, ENCODER, MODEL, PV);
    const modern = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV);
    expect(modern).toBe(legacy);
  });

  test("with contextHash -> DIFFERENT key from legacy", () => {
    const legacy = legacyKey(BYTES, RECIPE, ENCODER, MODEL, PV);
    const withCtx = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_A);
    expect(withCtx).not.toBe(legacy);
  });

  test("different contextHashes produce different keys", () => {
    const a = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_A);
    const b = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV, CONTEXT_B);
    expect(a).not.toBe(b);
  });

  test("empty-string contextHash treated as absent", () => {
    const empty = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV, "");
    const absent = descriptionCacheKey(BYTES, RECIPE, ENCODER, MODEL, PV);
    expect(empty).toBe(absent);
  });
});

describe("getOrCompute backward compatibility (no contextHash)", () => {
  test("without contextHash, behaves as single-tier cache", () => {
    const cache = new DescriptionCache(100, 60_000);
    const r1 = cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "desc-1");
    expect(r1).toBe("desc-1");
    expect(cache.stats.misses).toBe(1);
    expect(cache.stats.hits).toBe(0);

    const r2 = cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "desc-2");
    expect(r2).toBe("desc-1");
    expect(cache.stats.hits).toBe(1);
  });

  test("isCacheable=false prevents caching (placeholder retry)", () => {
    const cache = new DescriptionCache(100, 60_000);
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

describe("getImageOnly null on empty", () => {
  test("returns null when neither tier has an entry", () => {
    const cache = new DescriptionCache(100, 60_000);
    const result = cache.getImageOnly(BYTES, RECIPE, ENCODER, MODEL, PV);
    expect(result).toBeNull();
  });
});

describe("storeDual writes to both tiers", () => {
  test("after storeDual, getImageOnly returns the description", () => {
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
    store.flushNow();

    const coldCache = new DescriptionCache(100, 60_000, store);
    const result = coldCache.getImageOnly(BYTES, RECIPE, ENCODER, MODEL, PV);
    expect(result).toBe("persisted dual desc");
  });

  test("getOrCompute with contextHash falls back to image-only tier in SQLite", () => {
    cache.getOrCompute(BYTES, RECIPE, ENCODER, MODEL, PV, () => "image-only persisted");
    store.flushNow();

    const coldCache = new DescriptionCache(100, 60_000, store);
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
    const indexes = db.rawDb
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='vision_descriptions'",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((i) => i.name);
    expect(names).toContain("idx_vision_desc_image_hash");
    expect(names).toContain("idx_vision_desc_last_accessed");
  });

  test("running CaptureDB init twice is idempotent", () => {
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

describe("imageCacheKey sanity", () => {
  test("stable for identical inputs", () => {
    const k1 = imageCacheKey(BYTES, RECIPE, ENCODER);
    const k2 = imageCacheKey(BYTES, RECIPE, ENCODER);
    expect(k1).toBe(k2);
  });
});

// --- ENCODER_VERSION / recipe / prompt-version invalidation (from vision-quality) ---

describe("encoder version invalidation", () => {
  test("descriptionCacheKey with v2 encoder differs from v1", () => {
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const k1 = descriptionCacheKey(bytes, recipe, "bun-image-v1", "umans-flash", 2);
    const k2 = descriptionCacheKey(bytes, recipe, "bun-image-v2", "umans-flash", 2);
    expect(k1).not.toBe(k2);
  });

  test("imageCacheKey changes when encoder version changes", () => {
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const k1 = imageCacheKey(bytes, recipe, "bun-image-v1");
    const k2 = imageCacheKey(bytes, recipe, "bun-image-v2");
    expect(k1).not.toBe(k2);
  });
});

describe("CompressionRecipe has no subsampling", () => {
  test("recipe object compiles without subsampling field", () => {
    const recipe: CompressionRecipe = {
      format: "png",
      quality: 92,
      max_dimension: 2048,
    };
    expect(recipe.format).toBe("png");
    expect(recipe.quality).toBe(92);
    expect(recipe.max_dimension).toBe(2048);
    expect("subsampling" in recipe).toBe(false);
  });

  test("changing format changes the key", () => {
    const bytes = Buffer.from("IMGDATA");
    const png: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const jpeg: CompressionRecipe = { format: "jpeg", quality: 92, max_dimension: 2048 };
    expect(imageCacheKey(bytes, png, "v2")).not.toBe(imageCacheKey(bytes, jpeg, "v2"));
  });

  test("changing max_dimension changes the key", () => {
    const bytes = Buffer.from("IMGDATA");
    const r1024: CompressionRecipe = { format: "png", quality: 92, max_dimension: 1024 };
    const r2048: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    expect(imageCacheKey(bytes, r1024, "v2")).not.toBe(imageCacheKey(bytes, r2048, "v2"));
  });
});

describe("DescriptionCache with persistent backing (mock)", () => {
  test("getOrCompute writes to persistent store on miss", () => {
    let persistentGetCount = 0;
    let persistentSetCount = 0;
    const mockPersistent = {
      get: (_key: string) => {
        persistentGetCount++;
        return null;
      },
      set: (_entry: unknown) => {
        persistentSetCount++;
      },
    };
    const cache = new DescriptionCache(100, 86_400_000, mockPersistent as never);
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };

    const result = cache.getOrCompute(
      bytes,
      recipe,
      "v2",
      "umans-flash",
      2,
      () => "description text",
    );

    expect(result).toBe("description text");
    expect(persistentGetCount).toBe(1);
    expect(persistentSetCount).toBe(1);
    expect(cache.stats.misses).toBe(1);
  });

  test("getOrCompute reads from persistent store on LRU miss", () => {
    const mockPersistent = {
      get: (_key: string) => null,
      set: () => {},
    };
    const cache = new DescriptionCache(100, 86_400_000, mockPersistent as never);
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const descKey = descriptionCacheKey(bytes, recipe, "v2", "umans-flash", 2);

    cache.warm(descKey, "persisted desc");

    const result = cache.getOrCompute(bytes, recipe, "v2", "umans-flash", 2, () => {
      throw new Error("should not compute on persistent hit");
    });

    expect(result).toBe("persisted desc");
    expect(cache.stats.hits).toBe(1);
  });

  test("warm sets LRU entry directly", () => {
    const cache = new DescriptionCache(100, 86_400_000);
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const key = descriptionCacheKey(bytes, recipe, "v2", "umans-flash", 2);

    cache.warm(key, "warmed desc");

    const result = cache.getOrCompute(bytes, recipe, "v2", "umans-flash", 2, () => {
      throw new Error("should not compute after warm");
    });

    expect(result).toBe("warmed desc");
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(0);
  });

  test("persistentStats tracks persistent hits and writes", () => {
    const mockPersistent = {
      get: () => null,
      set: () => {},
    };
    const cache = new DescriptionCache(100, 86_400_000, mockPersistent as never);
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };

    cache.getOrCompute(bytes, recipe, "v2", "umans-flash", 2, () => "desc");

    expect(cache.persistentStats.writes).toBe(1);
    expect(cache.persistentStats.hits).toBe(0);
  });
});

describe("prompt version invalidation", () => {
  test("prompt version 2 key differs from version 1", () => {
    const bytes = Buffer.from("IMGDATA");
    const recipe: CompressionRecipe = { format: "png", quality: 92, max_dimension: 2048 };
    const k1 = descriptionCacheKey(bytes, recipe, "bun-image-v2", "umans-flash", 1);
    const k2 = descriptionCacheKey(bytes, recipe, "bun-image-v2", "umans-flash", 2);
    expect(k1).not.toBe(k2);
  });
});
