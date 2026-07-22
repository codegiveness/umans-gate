import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../src/db.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "umans-gate-ring-buffer-test-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Minimal insert helper that matches InsertParams. */
function insertCapture(db: CaptureDB, idx: number): number {
  return db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: `body-${idx}`,
    $rs: 7,
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
}

test("inserting exactly maxCaptures rows evicts nothing", () => {
  const maxCaptures = 5;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  for (let i = 0; i < maxCaptures; i++) {
    insertCapture(db, i);
  }
  const rows = db.list(1000);
  expect(rows.length).toBe(maxCaptures);
  // All inserted ids should still exist.
  for (let i = 1; i <= maxCaptures; i++) {
    expect(db.get(i)).not.toBeNull();
  }
  db.close();
});

test("inserting maxCaptures + 5 keeps only newest maxCaptures", () => {
  const maxCaptures = 5;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  const total = maxCaptures + 5; // 10
  for (let i = 0; i < total; i++) {
    insertCapture(db, i);
  }
  const rows = db.list(1000);
  expect(rows.length).toBe(maxCaptures);
  // The newest maxCaptures rows should be ids 6..10 (oldest 1..5 evicted).
  const ids = rows.map((r) => r.id).sort((a, b) => a - b);
  expect(ids).toEqual([6, 7, 8, 9, 10]);
  // Oldest ids should be gone.
  for (let i = 1; i <= 5; i++) {
    expect(db.get(i)).toBeNull();
  }
  // Newest ids should still exist.
  for (let i = 6; i <= 10; i++) {
    expect(db.get(i)).not.toBeNull();
  }
  db.close();
});

test("after eviction, a subsequent insert evicts exactly one more row", () => {
  const maxCaptures = 5;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  // Fill to capacity + overflow by 5, so ids 1-5 evicted, 6-10 retained.
  for (let i = 0; i < maxCaptures + 5; i++) {
    insertCapture(db, i);
  }
  expect(db.list(1000).length).toBe(maxCaptures);

  // Insert one more — should evict exactly id 6, keeping 7-11.
  insertCapture(db, 99);
  const rows = db.list(1000);
  expect(rows.length).toBe(maxCaptures);
  const ids = rows.map((r) => r.id).sort((a, b) => a - b);
  expect(ids).toEqual([7, 8, 9, 10, 11]);
  expect(db.get(6)).toBeNull();
  db.close();
});

test("ring-buffer DELETE uses primary-key index, not full table scan", () => {
  const maxCaptures = 5;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  // Insert enough rows to trigger at least one eviction.
  for (let i = 0; i < maxCaptures + 3; i++) {
    insertCapture(db, i);
  }
  db.close();

  // Re-open raw DB to inspect the query plan of the DELETE.
  // The outer DELETE must use SEARCH on the INTEGER PRIMARY KEY,
  // not a full SCAN of the captures table.
  const rawDb = new Database(dbPath);
  const plan = rawDb
    .prepare(
      "EXPLAIN QUERY PLAN DELETE FROM captures WHERE id IN (SELECT id FROM captures ORDER BY id DESC LIMIT $excess OFFSET $limit)",
    )
    .all({ $limit: maxCaptures, $excess: 3 }) as Array<{ detail: string }>;
  rawDb.close();

  const outerDelete = plan[0]?.detail ?? "";
  // The outer (first) step must be a PK seek, not a table scan.
  expect(outerDelete).toContain("SEARCH");
  expect(outerDelete).toContain("INTEGER PRIMARY KEY");
});

test("ring-buffer cleanup of 10,000 excess rows completes in <50ms", () => {
  const maxCaptures = 1000;
  const excess = 10000;
  const total = maxCaptures + excess;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });

  for (let i = 0; i < total; i++) {
    insertCapture(db, i);
  }

  const before = Date.now();
  insertCapture(db, total);
  const elapsed = Date.now() - before;

  expect(db.list(total).length).toBe(maxCaptures);
  expect(elapsed).toBeLessThan(50);
  db.close();
});

function captureWarnCalls(): {
  calls: string[];
  restore: () => void;
} {
  const originalError = console.error;
  const calls: string[] = [];
  const spy = mock((...args: unknown[]) => {
    if (typeof args[0] === "string") calls.push(args[0]);
  });
  console.error = spy as unknown as typeof console.error;
  return {
    calls,
    restore: () => {
      console.error = originalError;
    },
  };
}

test("warnIfNearCapacity fires exactly once when crossing the 80% threshold", () => {
  const maxCaptures = 10;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  const { calls, restore } = captureWarnCalls();

  // 8/10 == 0.8 — threshold is strictly "greater than", so no warning yet.
  for (let i = 0; i < 8; i++) insertCapture(db, i);
  expect(calls.some((l) => l.includes("ring buffer near capacity"))).toBe(false);

  // 9/10 == 0.9 > 0.8 — first crossing fires exactly once.
  insertCapture(db, 8);
  const firstCrossCalls = calls.filter((l) => l.includes("ring buffer near capacity"));
  expect(firstCrossCalls.length).toBe(1);
  expect(firstCrossCalls[0]).toContain("9/10");
  expect(firstCrossCalls[0]).toContain("90%");

  restore();
  db.close();
});

test("warnIfNearCapacity does not re-fire on subsequent inserts above 80%", () => {
  const maxCaptures = 10;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  const { calls, restore } = captureWarnCalls();

  for (let i = 0; i < 9; i++) insertCapture(db, i);
  expect(calls.filter((l) => l.includes("ring buffer near capacity")).length).toBe(1);

  for (let i = 9; i < 12; i++) insertCapture(db, i);
  expect(calls.filter((l) => l.includes("ring buffer near capacity")).length).toBe(1);

  restore();
  db.close();
});

test("warnIfNearCapacity fires again after buffer drops below and re-crosses", () => {
  const maxCaptures = 10;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  const { calls, restore } = captureWarnCalls();

  for (let i = 0; i < 9; i++) insertCapture(db, i);
  expect(calls.filter((l) => l.includes("ring buffer near capacity")).length).toBe(1);

  // clear() zeros rowCount but does NOT call warnIfNearCapacity. The flag
  // stays true until the next startCapture observes ratio < 0.8 and resets it.
  db.clear();

  for (let i = 0; i < 9; i++) insertCapture(db, i);
  expect(calls.filter((l) => l.includes("ring buffer near capacity")).length).toBe(2);

  restore();
  db.close();
});
