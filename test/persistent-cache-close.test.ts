// V6: close() must be idempotent and safe even when flushNow() throws.
// The timer callback already checks this.closed, but close() itself sets
// this.closed only AFTER flushNow() — if flushNow throws (re-thrown from
// a failed transaction), this.closed never gets set, leaving the store
// in a half-open state where the timer can still fire.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../src/db.js";
import { PersistentDescriptionStore } from "../src/vision/persistent-cache.js";

function makeTmpDbPath(): string {
  return join(
    tmpdir(),
    `persist-close-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
}

function makeCaptureDB(path: string): CaptureDB {
  return new CaptureDB({ dbPath: path, maxCaptures: 100 });
}

const _ENCODER = "bun-image-v2";
const _RECIPE = { format: "png", quality: 92, max_dimension: 2048 } as const;
const MODEL = "umans-flash";
const PV = 2;
const _SAMPLE_BYTES = Buffer.from("close-v6-bytes");

describe("PersistentDescriptionStore.close() safety (V6)", () => {
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

  test("close() sets closed=true even when flushNow throws", () => {
    const store = new PersistentDescriptionStore(db, 60_000, 100);
    // Buffer a write so flushNow has work to do.
    store.set({
      key: "close-fail-key",
      description: "Will fail to flush on close.",
      imageHash: "hash",
      model: MODEL,
      promptVersion: PV,
    });

    // Force the transaction to throw — simulates a SQLite failure during
    // the final flush that close() performs.
    const boom = new Error("simulated SQLite failure on close");
    db.transaction = mock(() => {
      throw boom;
    }) as unknown as typeof db.transaction;

    // close() must NOT re-throw the flush error, and must set closed=true.
    expect(() => store.close()).not.toThrow();

    // Access private `closed` via behavior: after close, flushNow is a no-op
    // (flushNow checks this.closed at line 89 and returns early). The pending
    // write was re-unshifted by flushNow's own catch block before rethrowing,
    // so it's still in the buffer. A second close() must also be a no-op:
    // if closed was NOT set, flushNow would try the (still-broken) transaction
    // again and throw — propagating out of close().
    expect(() => store.close()).not.toThrow();
  });

  test("close() does not throw", () => {
    const store = new PersistentDescriptionStore(db, 60_000, 100);
    // No pending writes — flushNow returns early, no error path.
    expect(() => store.close()).not.toThrow();
    // Idempotent.
    expect(() => store.close()).not.toThrow();
  });

  test("after close, the timer callback is a no-op", () => {
    // Use flushBatch=1 so a single set() triggers an immediate flushNow
    // (not a timer). Then we manually arm a timer-like call to verify the
    // closed guard short-circuits. We can't easily wait for the real timer
    // in a unit test, so we exercise the same code path the timer uses:
    // flushNow() called after close() must be a no-op.
    const store = new PersistentDescriptionStore(db, 60_000, 100, 1);
    store.set({
      key: "timer-noop-key",
      description: "Flushed immediately (batch=1).",
      imageHash: "hash",
      model: MODEL,
      promptVersion: PV,
    });
    store.close();

    // Spy on upsertVisionDescription to prove the timer callback path
    // (which calls flushNow) does NOT touch the DB after close.
    const upsertSpy = mock(() => {});
    db.upsertVisionDescription = upsertSpy as unknown as typeof db.upsertVisionDescription;

    // Simulate the timer firing after close — flushNow is the timer body.
    // With closed=true, flushNow returns at line 89 without splicing or
    // touching the DB.
    store.flushNow();
    expect(upsertSpy).not.toHaveBeenCalled();

    // And set() after close must not enqueue work that later flushes.
    // (set() still pushes to pendingWrites, but flushNow refuses to run.)
    store.set({
      key: "post-close-key",
      description: "Should not persist.",
      imageHash: "hash2",
      model: MODEL,
      promptVersion: PV,
    });
    store.flushNow();
    expect(upsertSpy).not.toHaveBeenCalled();
  });
});
