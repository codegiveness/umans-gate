// V5: flushNow failure must not cascade into set() and poison every
// subsequent write. Previously, when db.transaction threw, flushNow
// re-unshifted the entire batch and rethrew — the rethrow propagated
// through set() (line 74), and the re-unshifted batch stayed in
// pendingWrites, so the NEXT set() that crossed the flushBatch threshold
// would re-splice the same failing batch and throw AGAIN, indefinitely.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";
import { PersistentDescriptionStore } from "../../src/vision/persistent-cache.js";

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `persist-flush-cascade-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeCaptureDB(path: string): CaptureDB {
  return new CaptureDB({ dbPath: path, maxCaptures: 100 });
}

const MODEL = "umans-flash";
const PV = 2;

function entry(key: string, description: string) {
  return {
    key,
    description,
    imageHash: `hash-${key}`,
    model: MODEL,
    promptVersion: PV,
  };
}

describe("PersistentDescriptionStore.flushNow cascade (V5)", () => {
  let dbPath: string;
  let db: CaptureDB;
  let errorSpy: ReturnType<typeof mock>;
  let warnSpy: ReturnType<typeof mock>;
  let originalError: typeof console.error;
  let originalWarn: typeof console.warn;

  beforeEach(() => {
    dbPath = makeTmpDbPath();
    db = makeCaptureDB(dbPath);
    errorSpy = mock(() => {});
    warnSpy = mock(() => {});
    originalError = console.error;
    originalWarn = console.warn;
    console.error = errorSpy as unknown as typeof console.error;
    console.warn = warnSpy as unknown as typeof console.warn;
  });

  afterEach(() => {
    console.error = originalError;
    console.warn = originalWarn;
    db.close();
    try {
      unlinkSync(dbPath);
    } catch {
      // ignore
    }
  });

  test("set() does NOT throw when flushNow fails", () => {
    // flushBatch=1 so a single set() triggers an immediate flushNow.
    const store = new PersistentDescriptionStore(db, 60_000, 100, 1);

    const boom = new Error("simulated SQLite failure");
    db.transaction = mock(() => {
      throw boom;
    }) as unknown as typeof db.transaction;

    // Previously this threw; V5 must swallow and log.
    expect(() => store.set(entry("k1", "desc-1"))).not.toThrow();
  });

  test("failed writes are logged with cache keys", () => {
    const store = new PersistentDescriptionStore(db, 60_000, 100, 1);

    const boom = new Error("simulated SQLite failure");
    db.transaction = mock(() => {
      throw boom;
    }) as unknown as typeof db.transaction;

    store.set(entry("logged-key", "desc"));

    // The error log must mention the key so dropped writes are visible.
    const calls = errorSpy.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(calls).toContain("logged-key");
    // count is logged too.
    expect(calls).toContain("count");
  });

  test("subsequent set() calls work normally after a flush failure (no cascade)", () => {
    // Start with a failing transaction for the first flush.
    const store = new PersistentDescriptionStore(db, 60_000, 100, 1);

    const boom = new Error("simulated SQLite failure");
    const originalTransaction = db.transaction.bind(db);
    let callCount = 0;
    db.transaction = mock(<T>(fn: () => T): (() => T) => {
      callCount++;
      if (callCount === 1) throw boom;
      return originalTransaction(fn);
    }) as unknown as typeof db.transaction;

    // First set() triggers a failing flush — must not throw.
    expect(() => store.set(entry("fail-key", "fail-desc"))).not.toThrow();

    // Restore a working transaction.
    db.transaction = originalTransaction;

    // Second set() must succeed and persist — no cascade.
    store.set(entry("ok-key", "ok-desc"));

    const row = db.getVisionDescription("ok-key");
    expect(row).not.toBeNull();
    expect(row?.description).toBe("ok-desc");
  });

  test("after 3 retries, batch is dropped with a warning", () => {
    // flushBatch=1 so each set() triggers a flushNow.
    const store = new PersistentDescriptionStore(db, 60_000, 100, 1);

    // Transaction always fails.
    const boom = new Error("persistent SQLite failure");
    db.transaction = mock(() => {
      throw boom;
    }) as unknown as typeof db.transaction;

    // Drive 3 failing flushes. Each set() triggers flushNow.
    store.set(entry("retry-1", "d1"));
    store.set(entry("retry-2", "d2"));
    store.set(entry("retry-3", "d3"));

    // After 3 retries the batch is dropped and a warning is logged.
    const errCalls = errorSpy.mock.calls.map((c) => JSON.stringify(c)).join(" ");
    expect(errCalls).toContain("retries exhausted");
  });
});
