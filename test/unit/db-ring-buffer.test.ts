import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";

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

const VISION_META = JSON.stringify({
  status: "ok",
  httpStatus: 200,
  latencyMs: 42,
  description: "a cat",
  error: null,
  imageHash: "abc123",
  imageSize: 1234,
  model: "vision-model",
  target: "http://vision",
});

function insertVisionCapture(db: CaptureDB, idx: number): number {
  return db.insertVisionCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: `body-${idx}`,
    $rs: 7,
    $status: 200,
    $rh2: "{}",
    $rb2: "{}",
    $rs2: 2,
    $ct: "application/json",
    $dur: 10,
    $state: "done",
    $started_at: Date.now(),
    $finished_at: Date.now(),
    $inp: "http1.1",
    $outp: "http2",
    $model: "vision-model",
    $parent_capture_id: null,
    $vision_meta: VISION_META,
    $provider: "anthropic",
    $streaming: 0,
    $input_tokens: 1,
    $output_tokens: 2,
    $cache_creation_tokens: null,
    $cache_read_tokens: null,
    $total_input_tokens: null,
    $total_output_tokens: null,
    $thinking_tokens: null,
    $thinking_block_count: null,
    $ttft_ms: null,
    $tps: null,
    $usage_missing: 0,
    $metrics_extracted_at: null,
  });
}

test("vision rows are not evicted when non-vision ring buffer overflows", () => {
  const maxCaptures = 5;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  const visionId = insertVisionCapture(db, 0);
  for (let i = 0; i < maxCaptures + 3; i++) {
    insertCapture(db, i);
  }
  expect(db.get(visionId)).not.toBeNull();
  expect(db.listVisionCaptures(1000).length).toBe(1);
  db.close();
});

test("rowCount counts only non-vision rows after vision inserts", () => {
  const maxCaptures = 5;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  insertVisionCapture(db, 0);
  insertVisionCapture(db, 1);
  for (let i = 0; i < maxCaptures; i++) {
    insertCapture(db, i);
  }
  // list() returns ALL rows (vision + non-vision): 5 non-vision + 2 vision = 7
  expect(db.list(1000).length).toBe(maxCaptures + 2);
  expect(db.listVisionCaptures(1000).length).toBe(2);
  // Insert one more non-vision — should evict oldest non-vision, keep vision
  insertCapture(db, 99);
  expect(db.list(1000).length).toBe(maxCaptures + 2);
  expect(db.listVisionCaptures(1000).length).toBe(2);
  db.close();
});

test("clearVisionCaptures does not affect non-vision rowCount", () => {
  const maxCaptures = 5;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  for (let i = 0; i < 3; i++) {
    insertCapture(db, i);
  }
  insertVisionCapture(db, 0);
  insertVisionCapture(db, 1);
  db.clearVisionCaptures();
  expect(db.list(1000).length).toBe(3);
  insertCapture(db, 99);
  expect(db.list(1000).length).toBe(4);
  db.close();
});

test("restart preserves vision rows and re-inits rowCount to non-vision count only", () => {
  const maxCaptures = 5;
  const db = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  for (let i = 0; i < maxCaptures; i++) {
    insertCapture(db, i);
  }
  insertVisionCapture(db, 0);
  insertVisionCapture(db, 1);
  db.close();

  const db2 = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  expect(db2.listVisionCaptures(1000).length).toBe(2);
  insertCapture(db2, 99);
  expect(db2.listVisionCaptures(1000).length).toBe(2);
  expect(db2.list(1000).length).toBe(maxCaptures + 2);
  db2.close();
});
