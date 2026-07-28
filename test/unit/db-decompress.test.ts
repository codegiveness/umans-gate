import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CaptureDB } from "../../src/db.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "umans-gate-db-decompress-test-"));
  dbPath = join(tmpDir, "test.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Bytes that look like a zstd frame header but are garbage payload. */
const corruptedBlob = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00, 0xde, 0xad]);

test("get() returns null for corrupted body fields without crashing", () => {
  // 1. Create schema + a valid capture via CaptureDB
  const db = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const id = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: "{}",
    $rs: 2,
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  db.close();

  // 2. Corrupt the body BLOBs directly in SQLite
  const rawDb = new Database(dbPath);
  const stmt = rawDb.prepare(
    "UPDATE captures SET request_body = ?, response_body = ? WHERE id = ?",
  );
  stmt.run(corruptedBlob, corruptedBlob, id);
  rawDb.close();

  // 3. Reopen and read — should not throw, corrupted fields should be null
  const db2 = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const row = db2.get(id);
  expect(row).not.toBeNull();
  expect(row?.request_body).toBeNull();
  expect(row?.response_body).toBeNull();
  // Non-corrupted fields should be intact
  expect(row?.request_headers).toBe("{}");
  db2.close();
});

test("get() logs a warning with original byte length when decompression returns null", () => {
  const db = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  const id = db.startCapture({
    $method: "POST",
    $path: "/v1/messages",
    $url: "http://up",
    $rh: "{}",
    $rb: "{}",
    $rs: 2,
    $st: Date.now(),
    $state: "enqueued",
    $inp: "http1.1",
    $outp: "http1.1",
  });
  db.close();

  const rawDb = new Database(dbPath);
  rawDb.prepare("UPDATE captures SET request_body = ? WHERE id = ?").run(corruptedBlob, id);
  rawDb.close();

  const originalError = console.error;
  const errorSpy = mock((...args: unknown[]) => {
    originalError(...args);
  });
  console.error = errorSpy as unknown as typeof console.error;

  const db2 = new CaptureDB({
    dbPath,
    maxCaptures: 100,
    compressionEnabled: true,
  } as { dbPath: string; maxCaptures: number; compressionEnabled: boolean });
  db2.get(id);
  db2.close();

  console.error = originalError;

  const warned = errorSpy.mock.calls.some(
    (call) =>
      typeof call[0] === "string" &&
      call[0].includes("[warn]") &&
      call[0].includes("decompress") &&
      call[0].includes(String(corruptedBlob.byteLength)),
  );
  expect(warned).toBe(true);
});
