// Unit tests for src/vision/persistent-cache.ts — PersistentDescriptionStore.
// SQLite-backed description store: set/get, warming, TTL eviction, max-row enforcement, close.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";
import type { CompressionRecipe } from "../../src/vision/cache.js";
import { DescriptionCache, descriptionCacheKey, imageCacheKey } from "../../src/vision/cache.js";
import { PersistentDescriptionStore } from "../../src/vision/persistent-cache.js";

const ENCODER_V2 = "bun-image-v2";
const RECIPE: CompressionRecipe = {
  format: "png",
  quality: 92,
  max_dimension: 2048,
};

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `vision-persist-unit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeCaptureDB(path: string): CaptureDB {
  return new CaptureDB({ dbPath: path, maxCaptures: 100 });
}

const SAMPLE_BYTES = Buffer.from("fake-image-bytes-v1");
const MODEL = "umans-flash";
const PV = 2;

function makeKey(bytes: Buffer = SAMPLE_BYTES, suffix = ""): string {
  return descriptionCacheKey(bytes, RECIPE, ENCODER_V2, MODEL + suffix, PV);
}

describe("PersistentDescriptionStore", () => {
  let dbPath: string;
  let db: CaptureDB;
  let store: PersistentDescriptionStore;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = makeCaptureDB(dbPath);
    store = new PersistentDescriptionStore(db, 60_000, 100);
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

  test("set + get round-trip", () => {
    const key = makeKey();
    store.set({
      key,
      description: "A red 1x1 pixel.",
      imageHash: imageCacheKey(SAMPLE_BYTES, RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });
    const got = store.get(key);
    expect(got).toBe("A red 1x1 pixel.");
  });

  test("get returns null for missing key", () => {
    expect(store.get("nonexistent-key")).toBeNull();
  });

  test("set overwrites existing description (upsert)", () => {
    const key = makeKey();
    store.set({
      key,
      description: "First description.",
      imageHash: imageCacheKey(SAMPLE_BYTES, RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });
    store.set({
      key,
      description: "Updated description.",
      imageHash: imageCacheKey(SAMPLE_BYTES, RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });
    expect(store.get(key)).toBe("Updated description.");
  });

  test("get returns null and deletes expired entry", () => {
    const key = makeKey();
    const shortTtlStore = new PersistentDescriptionStore(db, 1, 100);
    shortTtlStore.set({
      key,
      description: "Soon to expire.",
      imageHash: imageCacheKey(SAMPLE_BYTES, RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait
    }
    expect(shortTtlStore.get(key)).toBeNull();
    expect(shortTtlStore.get(key)).toBeNull();
  });

  test("warmIntoCache returns entries and count", () => {
    const keys = [makeKey(), makeKey(Buffer.from("bytes-2"))];
    for (let i = 0; i < keys.length; i++) {
      store.set({
        key: keys[i],
        description: `Desc ${i}`,
        imageHash: imageCacheKey(
          i === 0 ? SAMPLE_BYTES : Buffer.from("bytes-2"),
          RECIPE,
          ENCODER_V2,
        ),
        model: MODEL,
        promptVersion: PV,
      });
    }
    const warmed: Array<{ key: string; description: string }> = [];
    const count = store.warmIntoCache((key, description) => {
      warmed.push({ key, description });
    }, 100);
    expect(count).toBe(2);
    expect(warmed.length).toBe(2);
    expect(warmed.map((w) => w.description)).toContain("Desc 0");
    expect(warmed.map((w) => w.description)).toContain("Desc 1");
  });

  test("warmIntoCache respects limit", () => {
    for (let i = 0; i < 5; i++) {
      store.set({
        key: makeKey(Buffer.from(`bytes-${i}`)),
        description: `Desc ${i}`,
        imageHash: imageCacheKey(Buffer.from(`bytes-${i}`), RECIPE, ENCODER_V2),
        model: MODEL,
        promptVersion: PV,
      });
    }
    const count = store.warmIntoCache(() => {}, 3);
    expect(count).toBe(3);
  });

  test("warmIntoCache on empty store returns 0", () => {
    const count = store.warmIntoCache(() => {}, 100);
    expect(count).toBe(0);
  });
});

describe("PersistentDescriptionStore eviction", () => {
  let dbPath: string;
  let db: CaptureDB;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = makeCaptureDB(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("evicts entries exceeding maxRows", () => {
    const store = new PersistentDescriptionStore(db, 999_999, 3);
    for (let i = 0; i < 5; i++) {
      store.set({
        key: makeKey(Buffer.from(`evict-bytes-${i}`)),
        description: `Desc ${i}`,
        imageHash: imageCacheKey(Buffer.from(`evict-bytes-${i}`), RECIPE, ENCODER_V2),
        model: MODEL,
        promptVersion: PV,
      });
    }
    store.flushNow();
    const deleted = db.evictVisionDescriptions(0, 3);
    expect(deleted).toBe(2);
    const count = (
      db as unknown as {
        visionDescStore: {
          stmtCount: { get: () => { c: number } };
        };
      }
    ).visionDescStore.stmtCount.get().c;
    expect(count).toBe(3);
    store.close();
  });

  test("evicts expired entries by TTL", () => {
    const ttlMs = 1;
    const store = new PersistentDescriptionStore(db, ttlMs, 100);
    store.set({
      key: makeKey(Buffer.from("ttl-bytes-1")),
      description: "Will expire.",
      imageHash: imageCacheKey(Buffer.from("ttl-bytes-1"), RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });
    const start = Date.now();
    while (Date.now() - start < 5) {
      // busy-wait
    }
    store.set({
      key: makeKey(Buffer.from("ttl-bytes-2")),
      description: "Triggers eviction.",
      imageHash: imageCacheKey(Buffer.from("ttl-bytes-2"), RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });
    expect(store.get(makeKey(Buffer.from("ttl-bytes-1")))).toBeNull();
    expect(store.get(makeKey(Buffer.from("ttl-bytes-2")))).toBe("Triggers eviction.");
    store.close();
  });

  test("eviction is throttled (not every set)", () => {
    const store = new PersistentDescriptionStore(db, 999_999, 100);
    store.set({
      key: makeKey(Buffer.from("throttle-1")),
      description: "First.",
      imageHash: imageCacheKey(Buffer.from("throttle-1"), RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });
    const evictSpy = mock(() => 0);
    const originalEvict = db.evictVisionDescriptions.bind(db);
    db.evictVisionDescriptions = evictSpy as unknown as typeof db.evictVisionDescriptions;

    store.set({
      key: makeKey(Buffer.from("throttle-2")),
      description: "Second.",
      imageHash: imageCacheKey(Buffer.from("throttle-2"), RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });
    expect(evictSpy).toHaveBeenCalledTimes(0);

    db.evictVisionDescriptions = originalEvict;
    store.close();
  });
});

describe("DescriptionCache with persistent backing", () => {
  let dbPath: string;
  let db: CaptureDB;
  let store: PersistentDescriptionStore;
  let cache: DescriptionCache;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = makeCaptureDB(dbPath);
    store = new PersistentDescriptionStore(db, 60_000, 100);
    cache = new DescriptionCache(10, 60_000, store);
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

  test("miss writes to both LRU and persistent store", () => {
    const key = makeKey();
    const result = cache.getOrCompute(
      SAMPLE_BYTES,
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "Computed description.",
    );
    expect(result).toBe("Computed description.");
    expect(cache.stats.misses).toBe(1);
    expect(cache.persistentStats.writes).toBe(1);
    expect(store.get(key)).toBe("Computed description.");
  });

  test("LRU miss falls through to persistent store", () => {
    const key = makeKey();
    store.set({
      key,
      description: "Persisted from before.",
      imageHash: imageCacheKey(SAMPLE_BYTES, RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });
    const freshCache = new DescriptionCache(10, 60_000, store);
    const result = freshCache.getOrCompute(
      SAMPLE_BYTES,
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "SHOULD NOT BE CALLED",
    );
    expect(result).toBe("Persisted from before.");
    expect(freshCache.stats.hits).toBe(1);
    expect(freshCache.persistentStats.hits).toBe(1);
    expect(freshCache.stats.misses).toBe(0);
  });

  test("warm populates LRU without touching persistent store", () => {
    const key = makeKey();
    cache.warm(key, "Warmed description.");
    const result = cache.getOrCompute(
      SAMPLE_BYTES,
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "SHOULD NOT BE CALLED",
    );
    expect(result).toBe("Warmed description.");
    expect(cache.stats.hits).toBe(1);
    expect(cache.stats.misses).toBe(0);
    expect(cache.persistentStats.writes).toBe(0);
  });

  test("persistent hit promotes to LRU (second hit is LRU hit)", () => {
    const key = makeKey();
    store.set({
      key,
      description: "From persistent.",
      imageHash: imageCacheKey(SAMPLE_BYTES, RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });
    const r1 = cache.getOrCompute(
      SAMPLE_BYTES,
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "SHOULD NOT BE CALLED",
    );
    expect(r1).toBe("From persistent.");
    expect(cache.persistentStats.hits).toBe(1);
    const r2 = cache.getOrCompute(
      SAMPLE_BYTES,
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "SHOULD NOT BE CALLED",
    );
    expect(r2).toBe("From persistent.");
    expect(cache.persistentStats.hits).toBe(1);
    expect(cache.stats.hits).toBe(2);
  });

  test("no persistent store — LRU-only behavior preserved", () => {
    const lruOnlyCache = new DescriptionCache(10, 60_000);
    const result = lruOnlyCache.getOrCompute(
      SAMPLE_BYTES,
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "LRU only.",
    );
    expect(result).toBe("LRU only.");
    expect(lruOnlyCache.stats.misses).toBe(1);
    expect(lruOnlyCache.persistentStats.writes).toBe(0);
    const result2 = lruOnlyCache.getOrCompute(
      SAMPLE_BYTES,
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "SHOULD NOT BE CALLED",
    );
    expect(result2).toBe("LRU only.");
    expect(lruOnlyCache.stats.hits).toBe(1);
  });

  test("different model produces different key", () => {
    const key1 = makeKey(SAMPLE_BYTES, "");
    const key2 = makeKey(SAMPLE_BYTES, "-other");
    expect(key1).not.toBe(key2);
  });

  test("different prompt version produces different key", () => {
    const key1 = descriptionCacheKey(SAMPLE_BYTES, RECIPE, ENCODER_V2, MODEL, 2);
    const key2 = descriptionCacheKey(SAMPLE_BYTES, RECIPE, ENCODER_V2, MODEL, 3);
    expect(key1).not.toBe(key2);
  });

  test("different encoder version produces different image hash", () => {
    const hashV1 = imageCacheKey(SAMPLE_BYTES, RECIPE, "bun-image-v1");
    const hashV2 = imageCacheKey(SAMPLE_BYTES, RECIPE, ENCODER_V2);
    expect(hashV1).not.toBe(hashV2);
  });

  test("different recipe produces different image hash", () => {
    const recipePng = { format: "png", quality: 92, max_dimension: 2048 };
    const recipeJpeg = { format: "jpeg", quality: 85, max_dimension: 1024 };
    const hashPng = imageCacheKey(SAMPLE_BYTES, recipePng, ENCODER_V2);
    const hashJpeg = imageCacheKey(SAMPLE_BYTES, recipeJpeg, ENCODER_V2);
    expect(hashPng).not.toBe(hashJpeg);
  });
});

describe("Cache warming simulation (restart scenario)", () => {
  let dbPath: string;
  let db: CaptureDB;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = makeCaptureDB(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("descriptions survive process restart via persistent store", () => {
    const store1 = new PersistentDescriptionStore(db, 60_000, 100);
    const cache1 = new DescriptionCache(10, 60_000, store1);

    const desc1 = cache1.getOrCompute(
      Buffer.from("restart-bytes-1"),
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "Description from process 1.",
    );
    expect(desc1).toBe("Description from process 1.");

    const desc2 = cache1.getOrCompute(
      Buffer.from("restart-bytes-2"),
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "Another description from process 1.",
    );
    expect(desc2).toBe("Another description from process 1.");

    store1.flushNow();

    const store2 = new PersistentDescriptionStore(db, 60_000, 100);
    const cache2 = new DescriptionCache(10, 60_000, store2);

    const warmedCount = store2.warmIntoCache((key, description) => {
      cache2.warm(key, description);
    }, 100);
    expect(warmedCount).toBe(2);

    const r1 = cache2.getOrCompute(
      Buffer.from("restart-bytes-1"),
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "SHOULD NOT BE CALLED",
    );
    expect(r1).toBe("Description from process 1.");

    const r2 = cache2.getOrCompute(
      Buffer.from("restart-bytes-2"),
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "SHOULD NOT BE CALLED",
    );
    expect(r2).toBe("Another description from process 1.");

    expect(cache2.stats.hits).toBe(2);
    expect(cache2.stats.misses).toBe(0);
    store1.close();
    store2.close();
  });

  test("descriptions survive even without explicit warming (persistent fallback)", () => {
    const store1 = new PersistentDescriptionStore(db, 60_000, 100);
    const cache1 = new DescriptionCache(10, 60_000, store1);

    cache1.getOrCompute(
      Buffer.from("fallback-bytes"),
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "Fallback description.",
    );

    store1.flushNow();

    const store2 = new PersistentDescriptionStore(db, 60_000, 100);
    const cache2 = new DescriptionCache(10, 60_000, store2);

    const result = cache2.getOrCompute(
      Buffer.from("fallback-bytes"),
      RECIPE,
      ENCODER_V2,
      MODEL,
      PV,
      () => "SHOULD NOT BE CALLED",
    );
    expect(result).toBe("Fallback description.");
    expect(cache2.persistentStats.hits).toBe(1);
    expect(cache2.stats.hits).toBe(1);
    store1.close();
    store2.close();
  });
});

describe("PersistentDescriptionStore close & transaction safety", () => {
  let dbPath: string;
  let db: CaptureDB;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = makeCaptureDB(dbPath);
  });

  afterEach(() => {
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("close() persists pending writes to SQLite", () => {
    const store = new PersistentDescriptionStore(db, 60_000, 100);
    const key = makeKey(Buffer.from("close-persist-bytes"));

    store.set({
      key,
      description: "Persisted on close.",
      imageHash: imageCacheKey(Buffer.from("close-persist-bytes"), RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });

    store.close();

    const row = db.getVisionDescription(key);
    expect(row).not.toBeNull();
    expect(row?.description).toBe("Persisted on close.");
  });

  test("close() persists pending writes across a new DB connection", () => {
    const store = new PersistentDescriptionStore(db, 60_000, 100);
    const key = makeKey(Buffer.from("restart-persist-bytes"));

    store.set({
      key,
      description: "Survives restart.",
      imageHash: imageCacheKey(Buffer.from("restart-persist-bytes"), RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });

    store.close();
    db.close();

    const db2 = makeCaptureDB(dbPath);
    const store2 = new PersistentDescriptionStore(db2, 60_000, 100);
    const got = store2.get(key);
    expect(got).toBe("Survives restart.");
    store2.close();
    db2.close();
  });

  test("transaction failure re-queues pending writes", () => {
    const store = new PersistentDescriptionStore(db, 60_000, 100);
    const key = makeKey(Buffer.from("txn-fail-bytes"));

    store.set({
      key,
      description: "Will be re-queued.",
      imageHash: imageCacheKey(Buffer.from("txn-fail-bytes"), RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });

    const originalTransaction = db.transaction.bind(db);
    let callCount = 0;
    db.transaction = mock(<T>(fn: () => T): (() => T) => {
      callCount++;
      if (callCount === 1) {
        throw new Error("simulated SQLite failure");
      }
      return originalTransaction(fn);
    }) as unknown as typeof db.transaction;

    expect(() => store.flushNow()).not.toThrow();
    expect(callCount).toBe(1);

    db.transaction = originalTransaction;

    store.flushNow();

    const row = db.getVisionDescription(key);
    expect(row).not.toBeNull();
    expect(row?.description).toBe("Will be re-queued.");

    store.close();
  });

  test("post-close timer flush is a no-op", () => {
    const store = new PersistentDescriptionStore(db, 60_000, 100, 1);
    const key = makeKey(Buffer.from("timer-noop-bytes"));

    store.set({
      key,
      description: "Buffered before close.",
      imageHash: imageCacheKey(Buffer.from("timer-noop-bytes"), RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });

    store.close();

    expect(db.getVisionDescription(key)?.description).toBe("Buffered before close.");

    const before = db.getVisionDescription(key)?.description;
    store.flushNow();
    const after = db.getVisionDescription(key)?.description;
    expect(after).toBe(before);
  });

  test("close() is idempotent and prevents future writes", () => {
    const store = new PersistentDescriptionStore(db, 60_000, 100);
    const key1 = makeKey(Buffer.from("idempotent-1"));

    store.set({
      key: key1,
      description: "Before close.",
      imageHash: imageCacheKey(Buffer.from("idempotent-1"), RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });

    store.close();
    store.close();

    expect(db.getVisionDescription(key1)?.description).toBe("Before close.");

    const key2 = makeKey(Buffer.from("idempotent-2"));
    store.set({
      key: key2,
      description: "After close — should not persist.",
      imageHash: imageCacheKey(Buffer.from("idempotent-2"), RECIPE, ENCODER_V2),
      model: MODEL,
      promptVersion: PV,
    });

    expect(db.getVisionDescription(key2)).toBeNull();
  });
});
