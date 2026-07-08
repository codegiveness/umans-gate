import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../src/db.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "umans-gate-db-test-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
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
