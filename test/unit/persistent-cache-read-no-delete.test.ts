// V9: get() must NOT perform a synchronous DELETE on expired rows.
// Previously, get() called this.db.deleteVisionDescription(key) when a
// row was expired (line 65). This moved a write (DELETE) onto the read
// path. The existing maybeEvict sweep (runs every 60s from set()) already
// cleans up expired rows via evictVisionDescriptions(cutoff, maxRows),
// so the inline DELETE is redundant and harmful to read latency.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";
import { PersistentDescriptionStore } from "../../src/vision/persistent-cache.js";

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `persist-read-no-delete-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeCaptureDB(path: string): CaptureDB {
  return new CaptureDB({ dbPath: path, maxCaptures: 100 });
}

const MODEL = "umans-flash";
const PV = 2;
const TTL_MS = 60_000;

function entry(key: string, description: string) {
  return {
    key,
    description,
    imageHash: `hash-${key}`,
    model: MODEL,
    promptVersion: PV,
  };
}

describe("PersistentDescriptionStore.get() read-path no-delete (V9)", () => {
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

  test("expired entry -> get() returns null", () => {
    const store = new PersistentDescriptionStore(db, TTL_MS, 100);
    const expiredKey = "expired-key";
    const pastNow = Date.now() - TTL_MS - 1000;
    db.upsertVisionDescription({
      $key: expiredKey,
      $image_hash: "hash",
      $model: MODEL,
      $prompt_version: PV,
      $description: "expired description",
      $now: pastNow,
    });

    expect(store.get(expiredKey)).toBeNull();
  });

  test("get() does NOT call deleteVisionDescription on expired rows", () => {
    const store = new PersistentDescriptionStore(db, TTL_MS, 100);
    const expiredKey = "expired-key-2";
    const pastNow = Date.now() - TTL_MS - 1000;
    db.upsertVisionDescription({
      $key: expiredKey,
      $image_hash: "hash",
      $model: MODEL,
      $prompt_version: PV,
      $description: "expired description",
      $now: pastNow,
    });

    const deleteSpy = mock(() => {});
    db.deleteVisionDescription = deleteSpy as unknown as typeof db.deleteVisionDescription;

    store.get(expiredKey);
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("maybeEvict still cleans up expired rows on its 60s interval", () => {
    const store = new PersistentDescriptionStore(db, TTL_MS, 100);
    const expiredKey = "evict-key";
    const pastNow = Date.now() - TTL_MS - 1000;
    db.upsertVisionDescription({
      $key: expiredKey,
      $image_hash: "hash",
      $model: MODEL,
      $prompt_version: PV,
      $description: "will be evicted",
      $now: pastNow,
    });

    // Row exists before eviction.
    expect(db.getVisionDescription(expiredKey)).not.toBeNull();

    // maybeEvict is private and called from set(). lastEvictionAt starts at 0,
    // so the first set() always triggers eviction (Date.now() - 0 >= 60_000).
    store.set(entry("trigger-key", "trigger"));

    // After eviction, the expired row is gone from the DB.
    expect(db.getVisionDescription(expiredKey)).toBeNull();
  });
});
