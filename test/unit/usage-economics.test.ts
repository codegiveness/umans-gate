// Unit tests: economics accounting functions with in-memory SQLite.
// Verifies accountCapturesUsage/accountCaptureUsage batch equivalence,
// idempotency, and usage_missing skip-but-mark behavior.

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  accountCapturesUsage,
  accountCaptureUsage,
  getDailyUsage,
  migrateEconomicsSchema,
} from "../../src/economics.js";

function createTestDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE IF NOT EXISTS captures (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      model            TEXT,
      input_tokens     INTEGER,
      output_tokens    INTEGER,
      cache_read_tokens      INTEGER,
      cache_creation_tokens  INTEGER,
      thinking_tokens        INTEGER,
      usage_missing          INTEGER DEFAULT 0,
      started_at             INTEGER,
      usage_accounted        INTEGER DEFAULT 0
    );
  `);
  migrateEconomicsSchema(db);
  return db;
}

function insertCapture(
  db: Database,
  params: {
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens?: number | null;
    cache_creation_tokens?: number | null;
    thinking_tokens?: number | null;
    usage_missing?: number;
    started_at?: number | null;
  },
): number {
  const result = db
    .prepare(
      `INSERT INTO captures (model, input_tokens, output_tokens, cache_read_tokens,
         cache_creation_tokens, thinking_tokens, usage_missing, started_at)
       VALUES ($model, $input, $output, $cache_read, $cache_creation, $thinking, $usage_missing, $started_at)`,
    )
    .run({
      $model: params.model,
      $input: params.input_tokens,
      $output: params.output_tokens,
      $cache_read: params.cache_read_tokens ?? null,
      $cache_creation: params.cache_creation_tokens ?? null,
      $thinking: params.thinking_tokens ?? null,
      $usage_missing: params.usage_missing ?? 0,
      $started_at: params.started_at ?? Date.now(),
    });
  return Number(result.lastInsertRowid);
}

function snapshotDailyUsage(db: Database) {
  return getDailyUsage(db, 100).map((r) => ({
    model: r.model,
    requests: r.requests,
    input_tokens: r.input_tokens,
    output_tokens: r.output_tokens,
    cost_total: Math.round(r.cost_total * 1e9) / 1e9,
  }));
}

test("accountCapturesUsage with empty array is a no-op", () => {
  const db = createTestDb();
  accountCapturesUsage(db, []);
  expect(getDailyUsage(db)).toHaveLength(0);
  db.close();
});

test("accountCapturesUsage produces same result as per-capture accountCaptureUsage", () => {
  const captures = [
    { model: "umans-glm-5.2", input_tokens: 1000, output_tokens: 500 },
    { model: "umans-glm-5.2", input_tokens: 2000, output_tokens: 300 },
    { model: "umans-flash", input_tokens: 500, output_tokens: 100 },
    { model: "umans-coder", input_tokens: 800, output_tokens: 200, cache_read_tokens: 400 },
  ];

  const dbPerCapture = createTestDb();
  const ids1: number[] = [];
  for (const c of captures) {
    ids1.push(insertCapture(dbPerCapture, c));
  }
  dbPerCapture.transaction(() => {
    for (const id of ids1) {
      accountCaptureUsage(dbPerCapture, id);
    }
  })();
  const resultPerCapture = snapshotDailyUsage(dbPerCapture);
  dbPerCapture.close();

  const dbBatch = createTestDb();
  const ids2: number[] = [];
  for (const c of captures) {
    ids2.push(insertCapture(dbBatch, c));
  }
  dbBatch.transaction(() => {
    accountCapturesUsage(dbBatch, ids2);
  })();
  const resultBatch = snapshotDailyUsage(dbBatch);
  dbBatch.close();

  expect(resultBatch).toEqual(resultPerCapture);
});

test("accountCapturesUsage is idempotent", () => {
  const db = createTestDb();
  const ids: number[] = [];
  ids.push(insertCapture(db, { model: "umans-glm-5.2", input_tokens: 1000, output_tokens: 500 }));
  ids.push(insertCapture(db, { model: "umans-flash", input_tokens: 200, output_tokens: 100 }));

  db.transaction(() => {
    accountCapturesUsage(db, ids);
  })();

  const afterFirst = snapshotDailyUsage(db);

  db.transaction(() => {
    accountCapturesUsage(db, ids);
  })();

  const afterSecond = snapshotDailyUsage(db);
  expect(afterSecond).toEqual(afterFirst);
  db.close();
});

test("accountCapturesUsage skips captures with missing usage but marks them accounted", () => {
  const db = createTestDb();
  const id1 = insertCapture(db, {
    model: "umans-glm-5.2",
    input_tokens: 1000,
    output_tokens: 500,
    usage_missing: 0,
  });
  const id2 = insertCapture(db, {
    model: "umans-flash",
    input_tokens: 200,
    output_tokens: 100,
    usage_missing: 1,
  });

  db.transaction(() => {
    accountCapturesUsage(db, [id1, id2]);
  })();

  const usage = getDailyUsage(db);
  expect(usage).toHaveLength(1);
  expect(usage[0].model).toBe("umans-glm-5.2");
  const accounted = db
    .prepare("SELECT usage_accounted FROM captures WHERE id IN (?, ?) ORDER BY id")
    .all(id1, id2) as Array<{ usage_accounted: number }>;
  expect(accounted.every((r) => r.usage_accounted === 1)).toBe(true);
  db.close();
});
