import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type MockUpstreamHandle, startMockLlmUpstream } from "./helpers/mock-llm-upstream";
import { type ProxyHandle, startProxy } from "./helpers/proxy";
import {
  LATEST_N_PER_MODEL_VIEW,
  PERFORMANCE_STATS_SQL,
  USAGE_COLUMNS_DDL,
  extractAnthropicNonStreaming,
  extractAnthropicStreaming,
  extractModel,
  extractOpenAiNonStreaming,
  extractOpenAiStreaming,
  parseAnthropicSse,
  parseOpenAiSse,
} from "./helpers/usage-extractors";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let upstream: MockUpstreamHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  upstream = await startMockLlmUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${upstream.port}`,
    STAMP_CACHE_TTL_ENABLED: "false",
    WARMER_ENABLED: "false",
  });
});

afterAll(async () => {
  await proxy.kill();
  await upstream.close();
});

async function getLatestCapture(
  path: string,
): Promise<{ body: string; duration_ms: number; request_body: string } | null> {
  await sleep(200);
  const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=50`);
  const captures = (await listRes.json()) as Array<{ id: number; path: string }>;
  // Find the last capture matching path (captures are newest-first)
  const cap = captures.find((c) => c.path === path);
  if (!cap) return null;
  const detailRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures/${cap.id}`);
  const detail = (await detailRes.json()) as {
    response_body: string;
    duration_ms: number;
    request_body: string;
  };
  return {
    body: detail.response_body ?? "",
    duration_ms: detail.duration_ms ?? 0,
    request_body: detail.request_body ?? "",
  };
}

// ─── extractModel tests ─────────────────────────────────────────────────────

describe("extractModel()", () => {
  test("extracts model from Anthropic request body", () => {
    expect(extractModel({ model: "claude-sonnet-4-5", messages: [] })).toBe("claude-sonnet-4-5");
  });

  test("extracts model from OpenAI request body", () => {
    expect(extractModel({ model: "gpt-4o", messages: [] })).toBe("gpt-4o");
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

  test("LATEST_N_PER_MODEL_VIEW creates a queryable view", () => {
    db.exec(LATEST_N_PER_MODEL_VIEW);
    // Insert test data: 3 models × 5 requests each
    for (let m = 0; m < 3; m++) {
      for (let i = 0; i < 5; i++) {
        db.run(
          `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
           VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-${m}', 'anthropic', ${i * 1000 + m * 100}, ${50 + i * 10}, ${100 - i}, ${100 + i}, ${50}, 0)`,
        );
      }
    }

    // Query the view: should return all 15 rows (all within latest 100)
    const rows = db.query("SELECT * FROM v_latest_requests_per_model").all() as Array<{
      model: string;
      rn: number;
    }>;
    expect(rows.length).toBe(15);

    // Each model should have rn from 1 to 5
    const byModel = new Map<string, number>();
    for (const r of rows) {
      byModel.set(r.model, (byModel.get(r.model) ?? 0) + 1);
    }
    for (const [, count] of byModel) {
      expect(count).toBe(5);
    }
  });

  test("latest-N view respects rn <= 100 limit (insert 120 rows per model, get 100)", () => {
    // Insert 120 more rows for model-0
    for (let i = 0; i < 120; i++) {
      db.run(
        `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
         VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-0', 'anthropic', ${100000 + i}, 50, 100, 100, 50, 0)`,
      );
    }

    const model0Rows = db
      .query("SELECT * FROM v_latest_requests_per_model WHERE model = 'model-0'")
      .all() as Array<{ rn: number }>;
    expect(model0Rows.length).toBe(100);
    // rn should be 1..100
    const rns = model0Rows.map((r) => r.rn).sort((a, b) => a - b);
    expect(rns[0]).toBe(1);
    expect(rns[99]).toBe(100);
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

    const rows = db.prepare(PERFORMANCE_STATS_SQL).all() as Array<{
      model: string;
      request_count: number;
      ttft_mean: number | null;
      ttft_p10: number | null;
      ttft_p50: number | null;
      ttft_p95: number | null;
      tps_mean: number | null;
      tps_p10: number | null;
      tps_p50: number | null;
      tps_p95: number | null;
    }>;
    const modelNull = rows.find((r) => r.model === "model-null");
    expect(modelNull).toBeDefined();
    expect(modelNull!.request_count).toBe(5);
    // Non-null tps values are [10, 20, 30]; mean=20
    expect(modelNull!.tps_mean).toBe(20);
    expect(modelNull!.tps_p50).toBe(20);
    // Non-null ttft values are [100, 200, 300]; mean=200
    expect(modelNull!.ttft_mean).toBe(200);
    expect(modelNull!.ttft_p50).toBe(200);

    // Insert a model with all-null tps/ttft — stats should be null
    for (let i = 0; i < 3; i++) {
      db.run(
        `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
         VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-all-null', 'anthropic', ${300000 + i}, NULL, NULL, 10, 5, 0)`,
      );
    }
    const afterAllNull = db.prepare(PERFORMANCE_STATS_SQL).all() as Array<{
      model: string;
      request_count: number;
      tps_mean: number | null;
      ttft_mean: number | null;
    }>;
    const allNull = afterAllNull.find((r) => r.model === "model-all-null");
    expect(allNull).toBeDefined();
    expect(allNull!.request_count).toBe(3);
    expect(allNull!.tps_mean).toBeNull();
    expect(allNull!.ttft_mean).toBeNull();
  });

  test("PERFORMANCE_STATS_SQL computes nearest-rank percentiles for clustered values", () => {
    // Insert 10 rows with known TTFT and TPS values.
    for (let i = 0; i < 10; i++) {
      db.run(
        `INSERT INTO captures (method, path, url, state, model, provider, started_at, ttft_ms, tps, input_tokens, output_tokens, usage_missing)
         VALUES ('POST', '/v1/messages', 'http://x', 'done', 'model-pct', 'anthropic', ${400000 + i}, ${100 + i * 10}, ${50 + i}, 10, 5, 0)`,
      );
    }

    const rows = db.prepare(PERFORMANCE_STATS_SQL).all() as Array<{
      model: string;
      request_count: number;
      ttft_mean: number;
      ttft_p10: number;
      ttft_p50: number;
      ttft_p95: number;
      tps_mean: number;
      tps_p10: number;
      tps_p50: number;
      tps_p95: number;
    }>;
    const pct = rows.find((r) => r.model === "model-pct");
    expect(pct).toBeDefined();
    expect(pct!.request_count).toBe(10);

    // TTFT values are 100..190 (step 10); mean = (100+190)/2 = 145
    expect(pct!.ttft_mean).toBe(145);
    // nearest-rank: ceil(0.10*10)=1 → value 100; ceil(0.50*10)=5 → value 140; ceil(0.95*10)=10 → value 190
    expect(pct!.ttft_p10).toBe(100);
    expect(pct!.ttft_p50).toBe(140);
    expect(pct!.ttft_p95).toBe(190);

    // TPS values are 50..59 (integer); mean = (50+59)/2 = 54.5
    expect(pct!.tps_mean).toBe(54.5);
    expect(pct!.tps_p10).toBe(50);
    expect(pct!.tps_p50).toBe(54);
    expect(pct!.tps_p95).toBe(59);
  });
});
