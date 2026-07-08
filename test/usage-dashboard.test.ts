import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type MockUpstreamHandle, startMockLlmUpstream } from "./helpers/mock-llm-upstream";
import { type ProxyHandle, startProxy } from "./helpers/proxy";
import {
  DASHBOARD_QUERY_SQL,
  LATEST_N_PER_MODEL_VIEW,
  MODEL_PERCENTILE_VIEW,
  type ModelRequestRow,
  type ModelSummary,
  PER_MODEL_RETENTION_SQL,
  USAGE_COLUMNS_DDL,
  type UsageMetrics,
  computePercentileStats,
  extractAnthropicNonStreaming,
  extractAnthropicStreaming,
  extractModel,
  extractOpenAiNonStreaming,
  extractOpenAiStreaming,
  parseAnthropicSse,
  parseOpenAiSse,
  percentile,
  summarizeByModel,
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

// ─── Percentile function tests ─────────────────────────────────────────────

describe("percentile() function", () => {
  test("empty array returns 0", () => {
    expect(percentile([], 50)).toBe(0);
  });

  test("single element returns that element for any p", () => {
    expect(percentile([42], 10)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 95)).toBe(42);
  });

  test("p50 (median) of odd-length array = middle element", () => {
    expect(percentile([10, 20, 30, 40, 50], 50)).toBe(30);
  });

  test("p50 of even-length array = upper-middle (nearest-rank)", () => {
    // n=4, rank=ceil(0.50*4)=2, sorted=[10,20,30,40], value=sorted[1]=20
    expect(percentile([10, 20, 30, 40], 50)).toBe(20);
  });

  test("p10 returns first element of sorted array", () => {
    // n=10, rank=ceil(0.10*10)=1, value=sorted[0]
    const vals = [50, 30, 10, 40, 20, 60, 80, 100, 70, 90];
    expect(percentile(vals, 10)).toBe(10);
  });

  test("p95 returns near-last element", () => {
    // n=20, rank=ceil(0.95*20)=19, value=sorted[18]
    const vals = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(percentile(vals, 95)).toBe(19);
  });

  test("p100 = max (clamped to n)", () => {
    expect(percentile([5, 3, 1, 4, 2], 100)).toBe(5);
  });

  test("p0 = min (clamped to 1)", () => {
    expect(percentile([5, 3, 1, 4, 2], 0)).toBe(1);
  });

  test("unsorted input is sorted internally", () => {
    expect(percentile([50, 10, 40, 20, 30], 50)).toBe(30);
  });
});

// ─── computePercentileStats tests ───────────────────────────────────────────

describe("computePercentileStats()", () => {
  test("returns null for all-null array", () => {
    expect(computePercentileStats([null, null, null])).toBeNull();
  });

  test("returns null for empty array", () => {
    expect(computePercentileStats([])).toBeNull();
  });

  test("skips nulls and computes stats on remaining", () => {
    const stats = computePercentileStats([10, null, 20, null, 30, null, 40, null, 50])!;
    expect(stats.count).toBe(5);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(50);
    expect(stats.p50).toBe(30);
    expect(stats.mean).toBe(30);
  });

  test("computes p10/p50/p95 for 20 values", () => {
    const vals = Array.from({ length: 20 }, (_, i) => (i + 1) * 10);
    const stats = computePercentileStats(vals)!;
    expect(stats.count).toBe(20);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(200);
    // p10: rank=ceil(0.10*20)=2, value=20
    expect(stats.p10).toBe(20);
    // p50: rank=ceil(0.50*20)=10, value=100
    expect(stats.p50).toBe(100);
    // p95: rank=ceil(0.95*20)=19, value=190
    expect(stats.p95).toBe(190);
  });
});

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

// ─── summarizeByModel: grouping + latest-N windowing ────────────────────────

function makeRow(model: string, capturedAt: number, ttft: number, tps: number): ModelRequestRow {
  return {
    model,
    provider: "anthropic",
    captured_at: capturedAt,
    metrics: {
      provider: "anthropic",
      streaming: true,
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_tokens: 0,
      cache_read_tokens: 0,
      total_input_tokens: 100,
      total_output_tokens: 50,
      thinking_tokens: null,
      ttft_ms: ttft,
      duration_ms: 500,
      tps,
      usage_missing: false,
    },
  };
}

describe("summarizeByModel() grouping + latest-N windowing", () => {
  test("groups by model and returns one summary per model", () => {
    const rows = [
      makeRow("claude-sonnet-4-5", 1000, 50, 100),
      makeRow("claude-sonnet-4-5", 2000, 60, 90),
      makeRow("gpt-4o", 3000, 40, 120),
      makeRow("gpt-4o", 4000, 45, 110),
    ];
    const summaries = summarizeByModel(rows, 100);
    expect(summaries.length).toBe(2);
    const claude = summaries.find((s) => s.model === "claude-sonnet-4-5")!;
    const gpt = summaries.find((s) => s.model === "gpt-4o")!;
    expect(claude.request_count).toBe(2);
    expect(gpt.request_count).toBe(2);
  });

  test("latest-N windowing: only takes N most recent per model", () => {
    const rows: ModelRequestRow[] = [];
    for (let i = 0; i < 150; i++) {
      rows.push(makeRow("claude-sonnet-4-5", i, 50 + i, 100 - i));
    }
    const summaries = summarizeByModel(rows, 100);
    expect(summaries[0].request_count).toBe(100);
    // Latest 100 = timestamps 50..149 (sorted desc)
    const ttftStats = summaries[0].ttft_ms!;
    // capturedAt 50..149 → ttft 100..199
    expect(ttftStats.min).toBe(100);
    expect(ttftStats.max).toBe(199);
  });

  test("different models get independent windows", () => {
    const rows: ModelRequestRow[] = [];
    for (let i = 0; i < 80; i++) {
      rows.push(makeRow("model-a", i, 50 + i, 100));
    }
    for (let i = 0; i < 120; i++) {
      rows.push(makeRow("model-b", i, 60 + i, 200));
    }
    const summaries = summarizeByModel(rows, 50);
    const a = summaries.find((s) => s.model === "model-a")!;
    const b = summaries.find((s) => s.model === "model-b")!;
    expect(a.request_count).toBe(50);
    expect(b.request_count).toBe(50);
  });

  test("streaming vs non-streaming counts", () => {
    const rows: ModelRequestRow[] = [
      { ...makeRow("m1", 1, 50, 100), provider: "anthropic" },
      { ...makeRow("m1", 2, 50, 100), provider: "anthropic" },
      {
        model: "m1",
        provider: "anthropic",
        captured_at: 3,
        metrics: { ...makeRow("m1", 3, 50, 100).metrics, streaming: false },
      },
    ];
    const summaries = summarizeByModel(rows, 100);
    expect(summaries[0].streaming_count).toBe(2);
    expect(summaries[0].non_streaming_count).toBe(1);
  });

  test("usage_missing_count tracks missing usage", () => {
    const rows: ModelRequestRow[] = [
      makeRow("m1", 1, 50, 100),
      {
        model: "m1",
        provider: "anthropic",
        captured_at: 2,
        metrics: { ...makeRow("m1", 2, 50, 100).metrics, usage_missing: true },
      },
    ];
    const summaries = summarizeByModel(rows, 100);
    expect(summaries[0].usage_missing_count).toBe(1);
  });

  test("summaries sorted by request_count desc", () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) => makeRow("few", i, 50, 100)),
      ...Array.from({ length: 10 }, (_, i) => makeRow("many", i, 50, 100)),
    ];
    const summaries = summarizeByModel(rows, 100);
    expect(summaries[0].model).toBe("many");
    expect(summaries[1].model).toBe("few");
  });

  test("null metrics fields produce null percentile stats", () => {
    const rows: ModelRequestRow[] = [
      {
        model: "m1",
        provider: "openai",
        captured_at: 1,
        metrics: {
          provider: "openai",
          streaming: false,
          input_tokens: 100,
          output_tokens: 50,
          cache_creation_tokens: null,
          cache_read_tokens: null,
          total_input_tokens: 100,
          total_output_tokens: 50,
          thinking_tokens: null,
          ttft_ms: null,
          duration_ms: 500,
          tps: null,
          usage_missing: false,
        },
      },
    ];
    const summaries = summarizeByModel(rows, 100);
    expect(summaries[0].ttft_ms).toBeNull();
    expect(summaries[0].tps).toBeNull();
    expect(summaries[0].cache_creation_tokens).toBeNull();
    expect(summaries[0].input_tokens).not.toBeNull();
  });
});

// ─── E2E: multi-model session through proxy → extraction → summary ──────────

describe("E2E: multi-model dashboard through proxy", () => {
  const dashboardRows: ModelRequestRow[] = [];

  beforeAll(async () => {
    upstream.reset();
    await fetch(`${proxy.baseUrl}/__inspect/api/clear`, { method: "POST" });
    await sleep(100);

    const models = ["claude-sonnet-4-5", "claude-haiku-3-5", "gpt-4o", "gpt-4o-mini"];
    for (const model of models) {
      const isOpenAi = model.startsWith("gpt");
      const path = isOpenAi ? "/v1/chat/completions" : "/v1/messages";
      for (let i = 0; i < 8; i++) {
        const reqBody = isOpenAi
          ? {
              model,
              max_tokens: 50,
              stream: true,
              stream_options: { include_usage: true },
              messages: [
                { role: "system", content: `Context for ${model}` },
                { role: "user", content: `Request ${i}` },
              ],
            }
          : {
              model,
              max_tokens: 50,
              stream: true,
              system: [
                {
                  type: "text",
                  text: `Context for ${model}`,
                  cache_control: { type: "ephemeral" },
                },
              ],
              messages: [{ role: "user", content: `Request ${i}` }],
            };

        const res = await fetch(`${proxy.baseUrl}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(reqBody),
        });
        expect(res.status).toBe(200);
        await res.text();

        const cap = await getLatestCapture(path);
        expect(cap).not.toBeNull();
        const reqBodyParsed = JSON.parse(cap!.request_body);
        const extractedModel = extractModel(reqBodyParsed);
        const provider = isOpenAi ? "openai" : "anthropic";

        let metrics: UsageMetrics;
        if (isOpenAi) {
          const chunks = parseOpenAiSse(cap!.body);
          const perChunk = cap!.duration_ms / Math.max(chunks.length, 1);
          const timed = chunks.map((ch, idx) => ({
            ...ch,
            received_at: Math.round(idx * perChunk),
          }));
          metrics = extractOpenAiStreaming(timed, 0);
        } else {
          const events = parseAnthropicSse(cap!.body);
          const perEvent = cap!.duration_ms / Math.max(events.length, 1);
          const timed = events.map((ev, idx) => ({
            ...ev,
            received_at: Math.round(idx * perEvent),
          }));
          metrics = extractAnthropicStreaming(timed, 0);
        }

        dashboardRows.push({
          model: extractedModel,
          provider,
          captured_at: Date.now(),
          metrics,
        });
      }
    }
  }, 120000);

  test("collected 32 requests across 4 models (8 each)", () => {
    expect(dashboardRows.length).toBe(32);
    const models = new Set(dashboardRows.map((r) => r.model));
    expect(models.size).toBe(4);
  });

  test("summarizeByModel produces 4 model summaries", () => {
    const summaries = summarizeByModel(dashboardRows, 100);
    expect(summaries.length).toBe(4);
    for (const s of summaries) {
      expect(s.request_count).toBe(8);
      expect(s.streaming_count).toBe(8);
      expect(s.usage_missing_count).toBe(0);
    }
  });

  test("TTFT percentiles computed for all models", () => {
    const summaries = summarizeByModel(dashboardRows, 100);
    for (const s of summaries) {
      expect(s.ttft_ms).not.toBeNull();
      expect(s.ttft_ms!.count).toBe(8);
      expect(s.ttft_ms!.p50).toBeGreaterThan(0);
      expect(s.ttft_ms!.p95).toBeGreaterThanOrEqual(s.ttft_ms!.p50);
      expect(s.ttft_ms!.p50).toBeGreaterThanOrEqual(s.ttft_ms!.p10);
      expect(s.ttft_ms!.min).toBeLessThanOrEqual(s.ttft_ms!.p10);
      expect(s.ttft_ms!.max).toBeGreaterThanOrEqual(s.ttft_ms!.p95);
    }
  });

  test("TPS percentiles computed for all models", () => {
    const summaries = summarizeByModel(dashboardRows, 100);
    for (const s of summaries) {
      expect(s.tps).not.toBeNull();
      expect(s.tps!.count).toBe(8);
      expect(s.tps!.p50).toBeGreaterThan(0);
      expect(s.tps!.p95).toBeGreaterThanOrEqual(s.tps!.p50);
    }
  });

  test("input/output token percentiles computed", () => {
    const summaries = summarizeByModel(dashboardRows, 100);
    for (const s of summaries) {
      expect(s.input_tokens).not.toBeNull();
      expect(s.output_tokens).not.toBeNull();
      expect(s.input_tokens!.p50).toBeGreaterThan(0);
      expect(s.output_tokens!.p50).toBeGreaterThan(0);
    }
  });

  test("Anthropic models have cache metrics, OpenAI models have cache_read (cached_tokens)", () => {
    const summaries = summarizeByModel(dashboardRows, 100);
    for (const s of summaries) {
      if (s.provider === "anthropic") {
        expect(s.cache_creation_tokens).not.toBeNull();
        expect(s.cache_read_tokens).not.toBeNull();
      } else {
        expect(s.cache_read_tokens).not.toBeNull();
        expect(s.cache_creation_tokens).toBeNull();
      }
    }
  });

  test("latest-N=5 window limits each model to 5 requests", () => {
    const summaries = summarizeByModel(dashboardRows, 5);
    for (const s of summaries) {
      expect(s.request_count).toBe(5);
    }
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

  test("MODEL_PERCENTILE_VIEW creates per-model percentile summary", () => {
    db.exec(MODEL_PERCENTILE_VIEW);
    const rows = db.query("SELECT * FROM v_model_percentiles").all() as Array<{
      model: string;
      request_count: number;
      ttft_p50: number | null;
      tps_p50: number | null;
    }>;
    expect(rows.length).toBe(3); // 3 models
    for (const r of rows) {
      expect(r.request_count).toBeGreaterThan(0);
      expect(r.ttft_p50).not.toBeNull();
      expect(r.tps_p50).not.toBeNull();
    }
  });

  test("DASHBOARD_QUERY_SQL produces p10/p50/p95 for all metrics", () => {
    const rows = db.prepare(DASHBOARD_QUERY_SQL).all() as Array<{
      model: string;
      ttft_p10: number | null;
      ttft_p50: number | null;
      ttft_p95: number | null;
      tps_p10: number | null;
      tps_p50: number | null;
      tps_p95: number | null;
      input_p10: number | null;
      input_p50: number | null;
      input_p95: number | null;
      output_p10: number | null;
      output_p50: number | null;
      output_p95: number | null;
      request_count: number;
    }>;
    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.request_count).toBeGreaterThan(0);
      expect(r.ttft_p10).not.toBeNull();
      expect(r.ttft_p50).not.toBeNull();
      expect(r.ttft_p95).not.toBeNull();
      expect(r.tps_p10).not.toBeNull();
      expect(r.tps_p50).not.toBeNull();
      expect(r.tps_p95).not.toBeNull();
      expect(r.input_p10).not.toBeNull();
      expect(r.input_p50).not.toBeNull();
      expect(r.input_p95).not.toBeNull();
      expect(r.output_p10).not.toBeNull();
      expect(r.output_p50).not.toBeNull();
      expect(r.output_p95).not.toBeNull();
    }
  });

  test("PER_MODEL_RETENTION_SQL deletes oldest rows beyond max_per_model", () => {
    // model-0 has 125 rows (5 original + 120 extra). Set max_per_model=50.
    const before = (
      db.query("SELECT COUNT(*) AS c FROM captures WHERE model = 'model-0'").get() as { c: number }
    ).c;
    expect(before).toBe(125);

    db.exec(PER_MODEL_RETENTION_SQL.replace(":MAX_PER_MODEL", "50"));

    const after = (
      db.query("SELECT COUNT(*) AS c FROM captures WHERE model = 'model-0'").get() as { c: number }
    ).c;
    expect(after).toBe(50);

    // Other models should be unaffected
    const model1Count = (
      db.query("SELECT COUNT(*) AS c FROM captures WHERE model = 'model-1'").get() as { c: number }
    ).c;
    expect(model1Count).toBe(5);
  });

  test("retention keeps the NEWEST rows (highest started_at)", () => {
    const maxStarted = (
      db.query("SELECT MAX(started_at) AS s FROM captures WHERE model = 'model-0'").get() as {
        s: number;
      }
    ).s;
    // The newest row from the 120 extras has started_at = 100000 + 119 = 100119
    expect(maxStarted).toBe(100119);
  });
});
