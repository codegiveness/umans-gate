import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "umans-gate-vision-ttl-test-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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

const VISION_PARAMS = {
  $method: "POST",
  $path: "/v1/messages",
  $url: "http://up",
  $rh: "{}",
  $rb: "body",
  $rs: 7,
  $status: 200,
  $rh2: "{}",
  $rb2: "{}",
  $rs2: 2,
  $ct: "application/json",
  $dur: 10,
  $state: "done" as const,
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
};

function insertVision(db: CaptureDB, startedAt: number): number {
  return db.insertVisionCapture({
    ...VISION_PARAMS,
    $started_at: startedAt,
    $finished_at: startedAt,
  });
}

function rawInsertVision(startedAt: number): void {
  const raw = new Database(dbPath);
  try {
    raw
      .prepare(
        `INSERT INTO captures
           (method, path, url, request_headers, request_body, request_size,
            response_status, response_headers, response_body, response_size,
            content_type, is_sse, duration_ms, state, started_at, finished_at,
            incoming_protocol, upstream_protocol, model,
            is_vision, parent_capture_id, vision_meta)
         VALUES
           ('POST', '/v1/messages', 'http://up', '{}', 'body', 7,
            200, '{}', '{}', 2,
            'application/json', 0, 10, 'done', $started_at, $started_at,
            'http1.1', 'http2', 'vision-model',
            1, NULL, $vision_meta)`,
      )
      .run({ $started_at: startedAt, $vision_meta: VISION_META });
  } finally {
    raw.close();
  }
}

test("sweepVisionCaptures deletes rows older than ttlMs", () => {
  const db = new CaptureDB({ dbPath, maxCaptures: 100 } as {
    dbPath: string;
    maxCaptures: number;
  });
  const now = Date.now();
  const sevenDays = 604_800_000;
  rawInsertVision(now - sevenDays - 1000);
  rawInsertVision(now - sevenDays - 60000);
  rawInsertVision(now - 1000);
  expect(db.listVisionCaptures(1000).length).toBe(3);
  const deleted = db.sweepVisionCaptures();
  expect(deleted).toBe(2);
  expect(db.listVisionCaptures(1000).length).toBe(1);
  db.close();
});

test("sweepVisionCaptures with custom ttlMs", () => {
  const db = new CaptureDB({ dbPath, maxCaptures: 100 } as {
    dbPath: string;
    maxCaptures: number;
  });
  const now = Date.now();
  const oneHour = 3_600_000;
  rawInsertVision(now - oneHour - 1000);
  rawInsertVision(now - 1000);
  expect(db.listVisionCaptures(1000).length).toBe(2);
  const deleted = db.sweepVisionCaptures(oneHour);
  expect(deleted).toBe(1);
  expect(db.listVisionCaptures(1000).length).toBe(1);
  db.close();
});

test("young vision rows survive sweep", () => {
  const db = new CaptureDB({ dbPath, maxCaptures: 100 } as {
    dbPath: string;
    maxCaptures: number;
  });
  const now = Date.now();
  rawInsertVision(now - 1000);
  rawInsertVision(now - 60000);
  const deleted = db.sweepVisionCaptures();
  expect(deleted).toBe(0);
  expect(db.listVisionCaptures(1000).length).toBe(2);
  db.close();
});

test("startup sweep deletes old vision rows on construction", () => {
  const maxCaptures = 100;
  const now = Date.now();
  const sevenDays = 604_800_000;

  const db1 = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  rawInsertVision(now - sevenDays - 1000);
  rawInsertVision(now - 1000);
  expect(db1.listVisionCaptures(1000).length).toBe(2);
  db1.close();

  const db2 = new CaptureDB({ dbPath, maxCaptures } as {
    dbPath: string;
    maxCaptures: number;
  });
  expect(db2.listVisionCaptures(1000).length).toBe(1);
  db2.close();
});

test("lazy sweep in insertVisionCapture is throttled to 60s", () => {
  const db = new CaptureDB({ dbPath, maxCaptures: 100 } as {
    dbPath: string;
    maxCaptures: number;
  });
  const now = Date.now();
  const sevenDays = 604_800_000;

  const youngId = insertVision(db, now - 1000);
  expect(db.listVisionCaptures(1000).length).toBe(1);

  rawInsertVision(now - sevenDays - 1000);
  expect(db.listVisionCaptures(1000).length).toBe(2);

  insertVision(db, now - 2000);
  expect(db.listVisionCaptures(1000).length).toBe(3);

  db.lastVisionSweepAt = 0;
  insertVision(db, now - 3000);
  expect(db.listVisionCaptures(1000).length).toBe(3);
  expect(db.get(youngId)).not.toBeNull();

  db.close();
});
