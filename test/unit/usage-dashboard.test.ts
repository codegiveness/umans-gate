import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";
import {
  extractModel,
  PERFORMANCE_STATS_SQL,
  USAGE_COLUMNS_DDL,
} from "../helpers/usage-extractors";

// ─── extractModel tests ─────────────────────────────────────────────────────

describe("extractModel()", () => {
  test("extracts model from Anthropic request body", () => {
    expect(extractModel({ model: "umans-glm-5.2", messages: [] })).toBe("umans-glm-5.2");
  });

  test("extracts model from OpenAI request body", () => {
    expect(extractModel({ model: "umans-flash", messages: [] })).toBe("umans-flash");
  });

  test("returns 'unknown' when model missing", () => {
    expect(extractModel({ messages: [] })).toBe("unknown");
  });

  test("returns 'unknown' when model is empty string", () => {
    expect(extractModel({ model: "", messages: [] })).toBe("unknown");
  });
});

// ─── SQL DDL tests: verify DDL executes and produces queryable results ─────

describe("SQL DDL: schema + views execute on SQLite", () => {
  let db: Database;

  beforeAll(() => {
    db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL;");

    // Create base captures table (simplified from src/db.ts)
    db.exec(`
      CREATE TABLE captures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        url TEXT NOT NULL,
        request_headers TEXT,
        request_body TEXT,
        request_size INTEGER DEFAULT 0,
        response_status INTEGER,
        response_headers TEXT,
        response_body TEXT,
        response_size INTEGER DEFAULT 0,
        content_type TEXT,
        is_sse INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        state TEXT DEFAULT 'streaming',
        started_at INTEGER,
        finished_at INTEGER,
        incoming_protocol TEXT,
        upstream_protocol TEXT
      );
    `);

    // Apply usage columns DDL (split into individual ALTER TABLE statements)
    const alterStatements = USAGE_COLUMNS_DDL.trim()
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of alterStatements) {
      try {
        db.exec(`${stmt};`);
      } catch {
        // Column may already exist — expected
      }
    }
  });

  afterAll(() => db.close());

  test("USAGE_COLUMNS_DDL adds all token-usage columns", () => {
    const cols = db.query("PRAGMA table_info(captures)").all() as Array<{ name: string }>;
    const colNames = new Set(cols.map((c) => c.name));
    const expected = [
      "provider",
      "model",
      "streaming",
      "input_tokens",
      "output_tokens",
      "cache_creation_tokens",
      "cache_read_tokens",
      "total_input_tokens",
      "total_output_tokens",
      "thinking_tokens",
      "ttft_ms",
      "tps",
      "usage_missing",
      "metrics_extracted_at",
    ];
    for (const col of expected) {
      expect(colNames.has(col)).toBe(true);
    }
  });

  test("PERFORMANCE_STATS_SQL with $limit returns rows within the limit window", () => {
    // Insert test data: 3 models × 5 requests each
    for (let m = 0; m < 3; m++) {
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
           VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-${m}', 'anthropic', ${i * 1000 + m * 100}, ${50 + i * 10}, ${100 - i}, ${100 + i}, ${50}, 0)`,
        );
      }
    }

    // Query with $limit=100: should return all 15 rows across 3 models
    const rows = db.prepare(PERFORMANCE_STATS_SQL).all({ $limit: 100 }) as Array<{
      model: string;
      request_count: number;
    }>;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.request_count).toBe(5);
    }
  });

  test("PERFORMANCE_STATS_SQL respects $limit parameter (insert 120 rows, limit 100)", () => {
    // Insert 120 rows for model-0
    for (let i = 0; i < 120; i++) {
      db.run(
        `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
         VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-0', 'anthropic', ${100000 + i}, 50, 100, 100, 50, 0)`,
      );
    }

    // With $limit=100: only 100 rows counted
    const rows100 = db.prepare(PERFORMANCE_STATS_SQL).all({ $limit: 100 }) as Array<{
      model: string;
      request_count: number;
    }>;
    const m0_100 = rows100.find((r) => r.model === "model-0");
    expect(m0_100).toBeDefined();
    expect(m0_100!.request_count).toBe(100);

    // With $limit=50: only 50 rows counted
    const rows50 = db.prepare(PERFORMANCE_STATS_SQL).all({ $limit: 50 }) as Array<{
      model: string;
      request_count: number;
    }>;
    const m0_50 = rows50.find((r) => r.model === "model-0");
    expect(m0_50).toBeDefined();
    expect(m0_50!.request_count).toBe(50);
  });

  test("PERFORMANCE_STATS_SQL degrades gracefully when $limit exceeds row count", () => {
    // Insert 10 rows for model-graceful
    for (let i = 0; i < 10; i++) {
      db.run(
        `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
         VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-graceful', 'anthropic', ${500000 + i}, 50, 100, 100, 50, 0)`,
      );
    }

    // $limit=200 but only 10 rows exist — should return 10
    const rows = db.prepare(PERFORMANCE_STATS_SQL).all({ $limit: 200 }) as Array<{
      model: string;
      request_count: number;
    }>;
    const mg = rows.find((r) => r.model === "model-graceful");
    expect(mg).toBeDefined();
    expect(mg!.request_count).toBe(10);
  });

  test("PERFORMANCE_STATS_SQL includes usage_missing=1 rows in request_count", () => {
    for (let i = 0; i < 3; i++) {
      db.run(
        `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
         VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-usage-missing', 'anthropic', ${500000 + i}, 50, 100, 10, 5, 1)`,
      );
    }
    const rows = db.prepare(PERFORMANCE_STATS_SQL).all({ $limit: 100 }) as Array<{
      model: string;
      request_count: number;
    }>;
    const missing = rows.find((r) => r.model === "model-usage-missing");
    expect(missing).toBeDefined();
    expect(missing!.request_count).toBe(3);
  });

  test("PERFORMANCE_STATS_SQL computes mean and percentiles and excludes null tps/ttft rows", () => {
    // Insert a model with 5 rows: 2 null tps, 3 non-null tps [10, 20, 30]
    // and 2 null ttft, 3 non-null ttft [100, 200, 300]
    for (let i = 0; i < 5; i++) {
      const tps = i < 2 ? null : 10 * (i - 1);
      const ttft = i < 2 ? null : 100 * (i - 1);
      db.run(
        `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
         VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-null', 'anthropic', ${200000 + i}, ${ttft ?? "NULL"}, ${tps ?? "NULL"}, 10, 5, 0)`,
      );
    }

    const rows = db.prepare(PERFORMANCE_STATS_SQL).all({ $limit: 100 }) as Array<{
      model: string;
      request_count: number;
      ttft_mean: number | null;
      ttft_max: number | null;
      ttft_p10: number | null;
      ttft_p50: number | null;
      ttft_p95: number | null;
      tps_mean: number | null;
      tps_min: number | null;
      tps_p10: number | null;
      tps_p50: number | null;
      tps_p95: number | null;
    }>;
    const modelNull = rows.find((r) => r.model === "model-null");
    expect(modelNull).toBeDefined();
    expect(modelNull!.request_count).toBe(5);
    // Non-null tps values are [10, 20, 30]; mean=20, min=10
    expect(modelNull!.tps_mean).toBe(20);
    expect(modelNull!.tps_min).toBe(10);
    expect(modelNull!.tps_p50).toBe(20);
    // Non-null ttft values are [100, 200, 300]; mean=200, max=300
    expect(modelNull!.ttft_mean).toBe(200);
    expect(modelNull!.ttft_max).toBe(300);
    expect(modelNull!.ttft_p50).toBe(200);

    // Insert a model with all-null tps/ttft — stats should be null
    for (let i = 0; i < 3; i++) {
      db.run(
        `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
         VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-all-null', 'anthropic', ${300000 + i}, NULL, NULL, 10, 5, 0)`,
      );
    }
    const afterAllNull = db.prepare(PERFORMANCE_STATS_SQL).all({ $limit: 100 }) as Array<{
      model: string;
      request_count: number;
      tps_mean: number | null;
      tps_min: number | null;
      ttft_mean: number | null;
      ttft_max: number | null;
    }>;
    const allNull = afterAllNull.find((r) => r.model === "model-all-null");
    expect(allNull).toBeDefined();
    expect(allNull!.request_count).toBe(3);
    expect(allNull!.tps_mean).toBeNull();
    expect(allNull!.tps_min).toBeNull();
    expect(allNull!.ttft_mean).toBeNull();
    expect(allNull!.ttft_max).toBeNull();
  });

  test("PERFORMANCE_STATS_SQL computes nearest-rank percentiles for clustered values", () => {
    // Insert 10 rows with known TTFT and TPS values.
    for (let i = 0; i < 10; i++) {
      db.run(
        `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
         VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-pct', 'anthropic', ${400000 + i}, ${100 + i * 10}, ${50 + i}, 10, 5, 0)`,
      );
    }

    const rows = db.prepare(PERFORMANCE_STATS_SQL).all({ $limit: 100 }) as Array<{
      model: string;
      request_count: number;
      ttft_mean: number;
      ttft_max: number;
      ttft_p10: number;
      ttft_p50: number;
      ttft_p95: number;
      tps_mean: number;
      tps_min: number;
      tps_p10: number;
      tps_p50: number;
      tps_p95: number;
    }>;
    const pct = rows.find((r) => r.model === "model-pct");
    expect(pct).toBeDefined();
    expect(pct!.request_count).toBe(10);

    // TTFT values are 100..190 (step 10); mean = (100+190)/2 = 145, max = 190
    expect(pct!.ttft_mean).toBe(145);
    expect(pct!.ttft_max).toBe(190);
    // nearest-rank: ceil(0.10*10)=1 → value 100; ceil(0.50*10)=5 → value 140; ceil(0.95*10)=10 → value 190
    expect(pct!.ttft_p10).toBe(100);
    expect(pct!.ttft_p50).toBe(140);
    expect(pct!.ttft_p95).toBe(190);

    // TPS values are 50..59 (integer); mean = (50+59)/2 = 54.5, min = 50
    expect(pct!.tps_mean).toBe(54.5);
    expect(pct!.tps_min).toBe(50);
    expect(pct!.tps_p10).toBe(50);
    expect(pct!.tps_p50).toBe(54);
    expect(pct!.tps_p95).toBe(59);
  });
});

// ─── Hot-reload mutation tests: performanceSampleLimit ─────────────────────────

describe("CaptureDB performanceSampleLimit hot-reload", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "umans-gate-perf-reload-"));
    dbPath = join(tmpDir, "test.db");
  });

  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

  test("mutating performanceSampleLimit reflects in subsequent getPerformanceStats() calls", () => {
    const captureDb = new CaptureDB({
      dbPath,
      maxCaptures: 200,
      performanceSampleCount: 50,
    } as { dbPath: string; maxCaptures: number; performanceSampleCount: number });

    const rawDb = new Database(dbPath);
    for (let i = 0; i < 100; i++) {
      rawDb.run(
        `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
         VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-reload', 'anthropic', ${1000000 + i}, 50, 100, 100, 50, 0)`,
      );
    }
    rawDb.close();

    const stats50 = captureDb.getPerformanceStats();
    const m50 = stats50.find((s) => s.model === "model-reload");
    expect(m50).toBeDefined();
    expect(m50!.request_count).toBe(50);

    captureDb.performanceSampleLimit = 100;
    const stats100 = captureDb.getPerformanceStats();
    const m100 = stats100.find((s) => s.model === "model-reload");
    expect(m100).toBeDefined();
    expect(m100!.request_count).toBe(100);

    captureDb.close();
  });
});
