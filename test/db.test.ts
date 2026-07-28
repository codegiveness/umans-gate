import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB, flattenUsage } from "../src/db.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "umans-gate-db-test-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const bigString = (size: number): string => "x".repeat(size);

test("startCapture + get round-trips large bodies", () => {
  const db = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const rh = JSON.stringify({ headers: bigString(512) });
  const rb = JSON.stringify({ body: bigString(512) });
  const id = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: rh,
    $rb: rb,
    $rs: Buffer.byteLength(rb),
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  const rh2 = JSON.stringify({ headers: bigString(512) });
  const rb2 = JSON.stringify({ body: bigString(512) });
  db.updateCapture({
    $id: id,
    $status: 200,
    $rh: rh2,
    $rb: rb2,
    $rs: Buffer.byteLength(rb2),
    $ct: "application/json",
    $sse: 0,
    $dur: 10,
    $fin: Date.now(),
    $status_source: "upstream",
    $gate_reason: null,
  });
  const row = db.get(id);
  expect(row).not.toBeNull();
  expect(row?.request_headers).toBe(rh);
  expect(row?.request_body).toBe(rb);
  expect(row?.response_headers).toBe(rh2);
  expect(row?.response_body).toBe(rb2);
  db.close();
});

test("reads legacy plain TEXT rows", () => {
  const rh = JSON.stringify({ headers: bigString(512) });
  const rb = JSON.stringify({ body: bigString(512) });
  const rh2 = JSON.stringify({ headers: bigString(512) });
  const rb2 = JSON.stringify({ body: bigString(512) });
  const rawDb = new Database(dbPath);
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS captures (
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
      state TEXT DEFAULT 'done',
      started_at INTEGER,
      finished_at INTEGER,
      incoming_protocol TEXT,
      upstream_protocol TEXT
    );
  `);
  const insert = rawDb.prepare(
    `INSERT INTO captures
       (method, path, url, request_headers, request_body, request_size,
        response_status, response_headers, response_body, response_size,
        content_type, is_sse, duration_ms, state, started_at, finished_at,
        incoming_protocol, upstream_protocol)
     VALUES
       (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', ?, ?, ?, ?)`,
  );
  insert.run(
    "POST",
    "/v1/messages",
    "http://up",
    rh,
    rb,
    Buffer.byteLength(rb),
    200,
    rh2,
    rb2,
    Buffer.byteLength(rb2),
    "application/json",
    0,
    10,
    Date.now(),
    Date.now(),
    "http1.1",
    "http1.1",
  );
  rawDb.close();

  const db = new CaptureDB({ dbPath, maxCaptures: 100 });
  const row = db.get(1);
  expect(row).not.toBeNull();
  expect(row?.request_headers).toBe(rh);
  expect(row?.request_body).toBe(rb);
  expect(row?.response_headers).toBe(rh2);
  expect(row?.response_body).toBe(rb2);
  db.close();
});

test("stores small payloads as TEXT", () => {
  const db = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const rb = bigString(128);
  const id = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: rb,
    $rs: Buffer.byteLength(rb),
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  db.close();

  const rawDb = new Database(dbPath);
  const row = rawDb
    .prepare("SELECT typeof(request_body) AS t FROM captures WHERE id = ?")
    .get(id) as { t: string };
  rawDb.close();
  expect(row.t).toBe("text");
});

test("vision capture round-trip", () => {
  const db = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const rh = JSON.stringify({ headers: bigString(600) });
  const rb = JSON.stringify({ body: bigString(600) });
  const rh2 = JSON.stringify({ headers: bigString(600) });
  const rb2 = JSON.stringify({ body: bigString(600) });
  const visionMeta = JSON.stringify({
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
  const id = db.insertVisionCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: rh,
    $rb: rb,
    $rs: Buffer.byteLength(rb),
    $status: 200,
    $rh2: rh2,
    $rb2: rb2,
    $rs2: Buffer.byteLength(rb2),
    $ct: "application/json",
    $dur: 10,
    $state: "done",
    $started_at: Date.now(),
    $finished_at: Date.now(),
    $inp: "http1.1",
    $outp: "http2",
    $model: "vision-model",
    $parent_capture_id: null,
    $vision_meta: visionMeta,
    $provider: "anthropic",
    $streaming: 0,
    $input_tokens: 1,
    $output_tokens: 2,
    $cache_creation_tokens: null,
    $cache_read_tokens: null,
    $total_input_tokens: null,
    $total_output_tokens: null,
    $thinking_tokens: null,
    $ttft_ms: null,
    $tps: null,
    $usage_missing: 0,
    $metrics_extracted_at: null,
  });
  const records = db.getVisionCallRecords(10);
  expect(records.length).toBe(1);
  expect(records[0]?.description).toBe("a cat");
  expect(records[0]?.status).toBe("ok");
  expect(records[0]?.incomingProtocol).toBe("http1.1");
  expect(records[0]?.upstreamProtocol).toBe("http2");
  expect(records[0]?.state).toBe("done");
  db.close();

  const rawDb = new Database(dbPath);
  const row = rawDb
    .prepare(
      "SELECT typeof(request_body) AS rt, typeof(response_body) AS bt FROM captures WHERE id = ?",
    )
    .get(id) as { rt: string; bt: string };
  rawDb.close();
  expect(row.rt).toBe("blob");
  expect(row.bt).toBe("blob");
});

test("vision capture lifecycle: enqueued → streaming → update → done", () => {
  const db = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const enqueuedMeta = JSON.stringify({
    status: "ok",
    httpStatus: null,
    latencyMs: 0,
    description: "",
    error: null,
    imageHash: "abc",
    imageSize: 100,
    model: "vision-model",
    target: "http://vision",
  });
  const id = db.insertVisionCapture({
    $method: "POST",
    $path: "/v1/chat/completions",
    $url: "http://vision",
    $rh: "{}",
    $rb: "{}",
    $rs: 0,
    $status: null,
    $rh2: "{}",
    $rb2: "",
    $rs2: 0,
    $ct: "application/json",
    $dur: 0,
    $state: "enqueued",
    $started_at: Date.now(),
    $finished_at: 0,
    $inp: "http1.1",
    $outp: "http2",
    $model: "vision-model",
    $parent_capture_id: 42,
    $vision_meta: enqueuedMeta,
    ...flattenUsage(null),
  });

  db.setState(id, "streaming");
  expect(db.get(id)?.state).toBe("streaming");

  const finalMeta = JSON.stringify({
    status: "ok",
    httpStatus: 200,
    latencyMs: 25,
    description: "a red cat",
    error: null,
    imageHash: "abc",
    imageSize: 100,
    model: "vision-model",
    target: "http://vision",
  });
  const responseBody = JSON.stringify({ description: "a red cat" });
  db.updateVisionCapture({
    $id: id,
    $status: 200,
    $rh: "{}",
    $rb: responseBody,
    $rs: Buffer.byteLength(responseBody),
    $reqBody: "{}",
    $reqHeaders: "{}",
    $reqSize: 2,
    $ct: "application/json",
    $sse: 0,
    $dur: 25,
    $fin: Date.now(),
    $status_source: "upstream",
    $gate_reason: null,
    $vision_meta: finalMeta,
    $model: "vision-model",
    ...flattenUsage(null),
  });

  const records = db.getVisionCallRecords(10);
  expect(records.length).toBe(1);
  expect(records[0]?.state).toBe("done");
  expect(records[0]?.description).toBe("a red cat");
  expect(records[0]?.incomingProtocol).toBe("http1.1");
  expect(records[0]?.upstreamProtocol).toBe("http2");
  expect(records[0]?.captureId).toBe(42);
  expect(db.get(id)?.state).toBe("done");
  db.close();
});

test("request_size/response_size match original byte counts", () => {
  const db = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const rb = JSON.stringify({ body: bigString(600) });
  const rb2 = JSON.stringify({ body: bigString(600) });
  const id = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: rb,
    $rs: Buffer.byteLength(rb),
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  db.updateCapture({
    $id: id,
    $status: 200,
    $rh: "{}",
    $rb: rb2,
    $rs: Buffer.byteLength(rb2),
    $ct: "application/json",
    $sse: 0,
    $dur: 10,
    $fin: Date.now(),
    $status_source: "upstream",
    $gate_reason: null,
  });
  const row = db.get(id);
  expect(row?.request_size).toBe(Buffer.byteLength(rb));
  expect(row?.response_size).toBe(Buffer.byteLength(rb2));
  db.close();
});

test("toggle compression off stores TEXT", () => {
  const db1 = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: false,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const rb = JSON.stringify({ body: bigString(600) });
  const id1 = db1.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: rb,
    $rs: Buffer.byteLength(rb),
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  db1.close();

  const rawDb1 = new Database(dbPath);
  const row1 = rawDb1
    .prepare("SELECT typeof(request_body) AS t FROM captures WHERE id = ?")
    .get(id1) as { t: string };
  rawDb1.close();
  expect(row1.t).toBe("text");

  const db2 = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const oldRow = db2.get(id1);
  expect(oldRow?.request_body).toBe(rb);

  const rb2 = JSON.stringify({ body: bigString(600) });
  const id2 = db2.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: rb2,
    $rs: Buffer.byteLength(rb2),
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  db2.close();

  const rawDb2 = new Database(dbPath);
  const row2 = rawDb2
    .prepare("SELECT typeof(request_body) AS t FROM captures WHERE id = ?")
    .get(id2) as { t: string };
  rawDb2.close();
  expect(row2.t).toBe("blob");
});

test("updateRequestBody compresses large bodies", () => {
  const db = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const rh = JSON.stringify({ headers: bigString(512) });
  const rb = JSON.stringify({ body: bigString(256) });
  const id = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: rh,
    $rb: rb,
    $rs: Buffer.byteLength(rb),
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  const newRb = JSON.stringify({ body: bigString(600) });
  db.updateRequestBody(id, newRb, Buffer.byteLength(newRb));
  const row = db.get(id);
  expect(row).not.toBeNull();
  expect(row?.request_body).toBe(newRb);
  expect(row?.request_size).toBe(Buffer.byteLength(newRb));

  const rawDb = new Database(dbPath);
  const t = rawDb
    .prepare("SELECT typeof(request_body) AS t FROM captures WHERE id = ?")
    .get(id) as { t: string };
  rawDb.close();
  expect(t.t).toBe("blob");
  db.close();
});

test("batchUpdate compresses response bodies", () => {
  const db = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const rh = JSON.stringify({ headers: bigString(512) });
  const rb = JSON.stringify({ body: bigString(256) });
  const id = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: rh,
    $rb: rb,
    $rs: Buffer.byteLength(rb),
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  const rh2 = JSON.stringify({ headers: bigString(512) });
  const rb2 = JSON.stringify({ body: bigString(600) });
  db.batchUpdate([
    {
      id,
      res: {
        $status: 200,
        $rh: rh2,
        $rb: rb2,
        $rs: Buffer.byteLength(rb2),
        $ct: "application/json",
        $sse: 0,
        $dur: 10,
        $fin: Date.now(),
        $status_source: "upstream",
        $gate_reason: null,
      },
    },
  ]);
  const row = db.get(id);
  expect(row).not.toBeNull();
  expect(row?.response_headers).toBe(rh2);
  expect(row?.response_body).toBe(rb2);

  const rawDb = new Database(dbPath);
  const t = rawDb
    .prepare("SELECT typeof(response_body) AS t FROM captures WHERE id = ?")
    .get(id) as { t: string };
  rawDb.close();
  expect(t.t).toBe("blob");
  db.close();
});

test("stale streaming captures are swept to done on startup", () => {
  // First, create a DB with a stale "streaming" capture
  const rawDb = new Database(dbPath);
  rawDb.exec(`
    CREATE TABLE IF NOT EXISTS captures (
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
  rawDb
    .prepare(
      "INSERT INTO captures (method, path, url, state) VALUES ('POST', '/v1/messages', 'http://up', 'streaming')",
    )
    .run();
  rawDb
    .prepare(
      "INSERT INTO captures (method, path, url, state) VALUES ('POST', '/v1/messages', 'http://up', 'enqueued')",
    )
    .run();
  rawDb
    .prepare(
      "INSERT INTO captures (method, path, url, state) VALUES ('GET', '/v1/models', 'http://up', 'done')",
    )
    .run();
  rawDb.close();

  // Now open via CaptureDB — should sweep stale rows
  const db = new CaptureDB({ dbPath, maxCaptures: 100 });
  const rows = db.list(10);
  expect(rows.length).toBe(3);
  for (const row of rows) {
    expect(row.state).toBe("done");
  }
  db.close();
});

test("stale captures are not swept on subsequent opens (only first open sweeps)", () => {
  // First open creates and sweeps
  const db1 = new CaptureDB({ dbPath, maxCaptures: 100 });
  db1.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: "",
    $rs: 0,
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  db1.setState(db1.list(1)[0].id, "streaming");
  db1.close();

  // Manually mark one as streaming (simulating a crash mid-flight)
  const rawDb = new Database(dbPath);
  rawDb.prepare("UPDATE captures SET state = 'streaming' WHERE id = 1").run();
  rawDb.close();

  // Second open sweeps it
  const db2 = new CaptureDB({ dbPath, maxCaptures: 100 });
  const row = db2.get(1);
  expect(row?.state).toBe("done");
  db2.close();
});

test("clear() preserves incidents — they expire only via sweepIncidents by age", () => {
  const db = new CaptureDB({ dbPath, maxCaptures: 100 } as {
    dbPath: string;
    maxCaptures: number;
  });
  const capId = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: "",
    $rs: 0,
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  db.recordIncident({
    captureId: capId,
    responsibleParty: "proxy",
    incidentType: "ttft_timeout",
    upstreamStatus: null,
    servedStatus: 504,
    reason: "TTFT watchdog exceeded",
  });

  const beforeClear = db.rawDb.prepare("SELECT COUNT(*) AS c FROM incidents").get() as {
    c: number;
  };
  expect(beforeClear.c).toBe(1);

  db.clear();

  const afterClear = db.rawDb.prepare("SELECT COUNT(*) AS c FROM incidents").get() as { c: number };
  expect(afterClear.c).toBe(1);

  const capturesAfter = db.rawDb.prepare("SELECT COUNT(*) AS c FROM captures").get() as {
    c: number;
  };
  expect(capturesAfter.c).toBe(0);

  db.close();
});

test("sweepIncidents deletes out-of-window incidents and keeps in-window ones", () => {
  const db = new CaptureDB({ dbPath, maxCaptures: 100, incidentRetentionDays: 30 } as {
    dbPath: string;
    maxCaptures: number;
    incidentRetentionDays: number;
  });
  const now = Date.now();

  const capIdRecent = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: "",
    $rs: 0,
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  db.recordIncident({
    captureId: capIdRecent,
    responsibleParty: "proxy",
    incidentType: "ttft_timeout",
    upstreamStatus: null,
    servedStatus: 504,
    reason: "recent",
  });
  db.rawDb
    .prepare("UPDATE incidents SET created_at = ? WHERE reason = 'recent'")
    .run(now - 10 * 86_400_000);

  const capIdOld = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: "",
    $rs: 0,
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  db.recordIncident({
    captureId: capIdOld,
    responsibleParty: "proxy",
    incidentType: "upstream_error",
    upstreamStatus: 500,
    servedStatus: 500,
    reason: "old",
  });
  db.rawDb
    .prepare("UPDATE incidents SET created_at = ? WHERE reason = 'old'")
    .run(now - 45 * 86_400_000);

  const deleted = db.sweepIncidents();
  expect(deleted).toBe(1);

  const remaining = db.rawDb
    .prepare("SELECT reason FROM incidents ORDER BY reason")
    .all() as Array<{ reason: string }>;
  expect(remaining.length).toBe(1);
  expect(remaining[0].reason).toBe("recent");

  db.close();
});

test("updateUpstreamP50 survives subsequent updateCapture (COALESCE guard)", () => {
  const db = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: false,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const id = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "[]",
    $rb: "{}",
    $rs: 2,
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });

  db.updateUpstreamP50(id, 2500, 42.5);

  db.updateCapture({
    $id: id,
    $status: 200,
    $rh: "[]",
    $rb: "hello",
    $rs: 5,
    $ct: "text/event-stream",
    $sse: 1,
    $dur: 1000,
    $fin: Date.now(),
    $status_source: "upstream",
    $gate_reason: null,
    $retry_attempt: 0,
    $ttft_exceeded: 0,
  });

  const row = db.get(id);
  expect(row?.upstream_ttft_p50_ms).toBe(2500);
  expect(row?.upstream_tps_p50).toBe(42.5);

  db.close();
});
