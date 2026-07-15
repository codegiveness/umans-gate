// SQLite capture store using bun:sqlite.
// WAL mode + write-behind queue for non-blocking captures.

import { Database } from "bun:sqlite";
import { compressText, decompressText } from "./compress.js";
import { accountCaptureUsage, backfillFromCaptures, migrateEconomicsSchema } from "./economics.js";
import { createLogger } from "./logger.js";
import type { CaptureRow, CaptureState, ProxyConfig } from "./types.js";
import {
  LATEST_N_PER_MODEL_VIEW,
  PERFORMANCE_STATS_SQL,
  USAGE_COLUMNS_DDL,
} from "./usage-extract.js";
import type { PerformanceStatsRow, UsageMetrics } from "./usage-extract.js";
import { VisionDescriptionStore } from "./vision-description-store.js";
import type { VisionCallRecord } from "./vision/handoff.js";

/** Prepared statement parameter types. */
interface InsertParams {
  $method: string;
  $path: string;
  $url: string;
  $rh: string;
  $rb: string;
  $rs: number;
  $st: number;
  $state: string;
  $inp: string;
  $outp: string;
}

export interface UpdateParams {
  $id: number;
  $status: number;
  $rh: string;
  $rb: string;
  $rs: number;
  $ct: string;
  $sse: number;
  $dur: number;
  $fin: number;
  $status_source: "upstream" | "gate" | null;
  $gate_reason: string | null;
  $usage?: UsageMetrics | null;
  $model?: string | null;
}

interface VisionInsertParams {
  $method: string;
  $path: string;
  $url: string;
  $rh: string;
  $rb: string;
  $rs: number;
  $status: number | null;
  $rh2: string;
  $rb2: string;
  $rs2: number;
  $ct: string;
  $dur: number;
  $state: CaptureState;
  $started_at: number;
  $finished_at: number;
  $inp: string;
  $outp: string;
  $model: string;
  $parent_capture_id: number | null;
  $vision_meta: string | null;
  $provider: string | null;
  $streaming: number | null;
  $input_tokens: number | null;
  $output_tokens: number | null;
  $cache_creation_tokens: number | null;
  $cache_read_tokens: number | null;
  $total_input_tokens: number | null;
  $total_output_tokens: number | null;
  $thinking_tokens: number | null;
  $ttft_ms: number | null;
  $tps: number | null;
  $usage_missing: number | null;
  $metrics_extracted_at: number | null;
}

export interface VisionUpdateParams {
  $id: number;
  $status: number | null;
  $rh: string;
  $rb: string;
  $rs: number;
  $ct: string;
  $sse: number;
  $dur: number;
  $fin: number;
  $status_source: "upstream" | "gate" | null;
  $gate_reason: string | null;
  $vision_meta: string | null;
  $model: string | null;
  $provider: string | null;
  $streaming: number | null;
  $input_tokens: number | null;
  $output_tokens: number | null;
  $cache_creation_tokens: number | null;
  $cache_read_tokens: number | null;
  $total_input_tokens: number | null;
  $total_output_tokens: number | null;
  $thinking_tokens: number | null;
  $ttft_ms: number | null;
  $tps: number | null;
  $usage_missing: number | null;
  $metrics_extracted_at: number | null;
}

/** Flatten a UsageMetrics object into the `$`-prefixed params for stmtUpdate.
 *  Returns nulls when usage is absent so a single prepared statement suffices. */
export function flattenUsage(usage: UsageMetrics | null | undefined) {
  if (!usage) {
    return {
      $provider: null,
      $streaming: null,
      $input_tokens: null,
      $output_tokens: null,
      $cache_creation_tokens: null,
      $cache_read_tokens: null,
      $total_input_tokens: null,
      $total_output_tokens: null,
      $thinking_tokens: null,
      $ttft_ms: null,
      $tps: null,
      $usage_missing: null,
      $metrics_extracted_at: null,
    };
  }
  return {
    $provider: usage.provider,
    $streaming: usage.streaming ? 1 : 0,
    $input_tokens: usage.input_tokens,
    $output_tokens: usage.output_tokens,
    $cache_creation_tokens: usage.cache_creation_tokens,
    $cache_read_tokens: usage.cache_read_tokens,
    $total_input_tokens: usage.total_input_tokens,
    $total_output_tokens: usage.total_output_tokens,
    $thinking_tokens: usage.thinking_tokens,
    $ttft_ms: usage.ttft_ms,
    $tps: usage.tps,
    $usage_missing: usage.usage_missing ? 1 : 0,
    $metrics_extracted_at: Date.now(),
  };
}

/** Add a column only if it doesn't already exist (migration safety). */
function addColumnIfMissing(db: Database, name: string, type: string): void {
  try {
    db.exec(`ALTER TABLE captures ADD COLUMN ${name} ${type}`);
  } catch {
    // Column already exists — expected for existing DBs.
  }
}

/** Run all schema migrations/pragmas for a capture database.
 *  Idempotent: safe to call on every startup, including existing databases. */
export function migrateCaptureSchema(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec("PRAGMA temp_store = MEMORY;");
  db.exec("PRAGMA cache_size = -64000;"); // 64MB page cache (was 20MB)
  db.exec("PRAGMA mmap_size = 268435456;"); // 256MB memory-mapped I/O
  db.exec("PRAGMA journal_size_limit = 67108864;"); // 64MB WAL cap
  db.exec("PRAGMA busy_timeout = 5000;"); // 5s wait on lock contention

  db.exec(`
    CREATE TABLE IF NOT EXISTS captures (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      method           TEXT NOT NULL,
      path             TEXT NOT NULL,
      url              TEXT NOT NULL,
      request_headers  TEXT,
      request_body     TEXT,
      request_size     INTEGER DEFAULT 0,
      response_status  INTEGER,
      response_headers TEXT,
      response_body    TEXT,
      response_size    INTEGER DEFAULT 0,
      content_type     TEXT,
      is_sse           INTEGER DEFAULT 0,
      duration_ms      INTEGER DEFAULT 0,
      state            TEXT DEFAULT 'streaming',
      started_at       INTEGER,
      finished_at      INTEGER,
      incoming_protocol TEXT,
      upstream_protocol TEXT
    );
  `);

  // Add columns to existing DBs (no-op if already present).
  addColumnIfMissing(db, "incoming_protocol", "TEXT");
  addColumnIfMissing(db, "upstream_protocol", "TEXT");
  // Vision merge: flag vision-call rows + link to parent capture.
  addColumnIfMissing(db, "is_vision", "INTEGER DEFAULT 0");
  addColumnIfMissing(db, "parent_capture_id", "INTEGER");
  // Vision metadata JSON (status, httpStatus, latencyMs, description, error,
  // imageHash, imageSize, model, target) stored separately so request_body
  // and response_body can hold the actual HTTP request/response exchanged
  // with the vision model.
  addColumnIfMissing(db, "vision_meta", "TEXT");
  // Status source: "upstream" = response from upstream API, "gate" = proxy-generated.
  addColumnIfMissing(db, "status_source", "TEXT");
  // Human-readable explanation when the proxy (gate) generated the HTTP status.
  addColumnIfMissing(db, "gate_reason", "TEXT");

  // Token-usage columns: split DDL on ';', strip SQL comments, exec each individually so
  // SQLite doesn't halt on the first "duplicate column" error when an existing DB is reopened.
  for (const raw of USAGE_COLUMNS_DDL.split(";")) {
    const stmt = raw
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    if (!stmt) continue;
    try {
      db.exec(stmt);
    } catch {
      // Column already exists — expected for existing DBs.
    }
  }

  // Latest-N-per-model materialized view (IF NOT EXISTS → safe on every restart).
  db.exec(LATEST_N_PER_MODEL_VIEW);

  // Covering indexes for fast aggregation queries.
  // Without these, every stats query scans the entire captures table.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_captures_model_started
      ON captures(model, started_at DESC)
      WHERE model IS NOT NULL AND state = 'done';
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_captures_model_usage
      ON captures(model, usage_missing, started_at DESC)
      WHERE model IS NOT NULL;
  `);

  // Null out tps values computed before the 1-second generation-time floor
  // was introduced. Idempotent: after the first run no rows match because
  // computeTps() already returns null for short generations.
  db.exec(`
    UPDATE captures
    SET tps = NULL
    WHERE tps IS NOT NULL
      AND duration_ms IS NOT NULL
      AND (duration_ms - COALESCE(ttft_ms, 0)) < 1000
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS vision_descriptions (
      key              TEXT PRIMARY KEY,
      image_hash       TEXT NOT NULL,
      model            TEXT NOT NULL,
      prompt_version   INTEGER NOT NULL,
      description      TEXT NOT NULL,
      created_at       INTEGER NOT NULL,
      last_accessed_at INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vision_desc_last_accessed
      ON vision_descriptions(last_accessed_at ASC);
  `);

  // Economics schema (model_pricing + daily_usage tables, usage_accounted column).
  migrateEconomicsSchema(db);
  // Account captures from before the economics migration.
  backfillFromCaptures(db);
}

/** Capture database — wraps a bun:sqlite Database with prepared statements. */
export class CaptureDB {
  private static readonly log = createLogger("db");
  private db: Database;
  private stmtInsert: ReturnType<Database["prepare"]>;
  private stmtUpdate: ReturnType<Database["prepare"]>;
  private stmtDeleteOld: ReturnType<Database["prepare"]>;
  private stmtGet: ReturnType<Database["prepare"]>;
  private stmtList: ReturnType<Database["prepare"]>;
  private stmtCount: ReturnType<Database["prepare"]>;
  private stmtSetState: ReturnType<Database["prepare"]>;
  private stmtUpdateRequestBody: ReturnType<Database["prepare"]>;
  private stmtPerformanceStats: ReturnType<Database["prepare"]>;
  private stmtInsertVision: ReturnType<Database["prepare"]>;
  private stmtUpdateVision: ReturnType<Database["prepare"]>;
  private stmtListVision: ReturnType<Database["prepare"]>;
  private stmtClearVision: ReturnType<Database["prepare"]>;
  private stmtListVisionRecords: ReturnType<Database["prepare"]>;
  private readonly visionDescStore: VisionDescriptionStore;
  private rowCount: number;
  readonly maxCaptures: number;
  compressionEnabled: boolean;

  constructor(
    config: Pick<ProxyConfig, "dbPath" | "maxCaptures"> &
      Partial<Pick<ProxyConfig, "compressionEnabled">>,
  ) {
    this.db = new Database(config.dbPath);
    this.maxCaptures = config.maxCaptures;
    this.compressionEnabled = config.compressionEnabled ?? true;

    migrateCaptureSchema(this.db);

    this.stmtInsert = this.db.prepare(`
      INSERT INTO captures (method, path, url, request_headers, request_body, request_size, started_at, state, incoming_protocol, upstream_protocol)
      VALUES ($method, $path, $url, $rh, $rb, $rs, $st, $state, $inp, $outp)
    `);
    this.stmtUpdate = this.db.prepare(`
      UPDATE captures SET
        response_status  = $status,
        response_headers = $rh,
        response_body    = $rb,
        response_size    = $rs,
        content_type     = $ct,
        is_sse           = $sse,
        duration_ms      = $dur,
        state            = 'done',
        finished_at      = $fin,
        status_source    = $status_source,
        gate_reason      = $gate_reason,
        provider               = $provider,
        streaming              = $streaming,
        model                  = $model,
        input_tokens           = $input_tokens,
        output_tokens          = $output_tokens,
        cache_creation_tokens  = $cache_creation_tokens,
        cache_read_tokens      = $cache_read_tokens,
        total_input_tokens     = $total_input_tokens,
        total_output_tokens    = $total_output_tokens,
        thinking_tokens        = $thinking_tokens,
        ttft_ms                = $ttft_ms,
        tps                    = $tps,
        usage_missing          = $usage_missing,
        metrics_extracted_at   = $metrics_extracted_at
      WHERE id = $id
    `);
    this.stmtDeleteOld = this.db.prepare(
      "DELETE FROM captures WHERE id IN (SELECT id FROM captures ORDER BY id DESC LIMIT $excess OFFSET $limit)",
    );
    this.sweepStaleCaptures();
    this.stmtGet = this.db.prepare("SELECT * FROM captures WHERE id = $id");
    this.stmtList = this.db.prepare(
      `SELECT id, method, path, response_status, is_sse, content_type,
              request_size, response_size, duration_ms, state, started_at, finished_at,
              incoming_protocol, upstream_protocol, model, usage_missing,
              ttft_ms, tps, input_tokens, output_tokens,
              cache_creation_tokens, cache_read_tokens,
              total_input_tokens, total_output_tokens, is_vision,
              status_source, gate_reason
       FROM captures ORDER BY id DESC LIMIT ?`,
    );
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS c FROM captures");
    this.stmtSetState = this.db.prepare("UPDATE captures SET state = $state WHERE id = $id");
    this.stmtUpdateRequestBody = this.db.prepare(
      "UPDATE captures SET request_body = $rb, request_size = $rs WHERE id = $id",
    );
    this.stmtPerformanceStats = this.db.prepare(PERFORMANCE_STATS_SQL);
    this.stmtInsertVision = this.db.prepare(
      `INSERT INTO captures
         (method, path, url, request_headers, request_body, request_size,
          response_status, response_headers, response_body, response_size,
          content_type, is_sse, duration_ms, state, started_at, finished_at,
          incoming_protocol, upstream_protocol, model,
          is_vision, parent_capture_id, vision_meta,
          provider, streaming, input_tokens, output_tokens,
          cache_creation_tokens, cache_read_tokens,
          total_input_tokens, total_output_tokens, thinking_tokens,
          ttft_ms, tps, usage_missing, metrics_extracted_at)
       VALUES
         ($method, $path, $url, $rh, $rb, $rs,
          $status, $rh2, $rb2, $rs2,
          $ct, 0, $dur, $state, $started_at, $finished_at,
          $inp, $outp, $model,
          1, $parent_capture_id, $vision_meta,
          $provider, $streaming, $input_tokens, $output_tokens,
          $cache_creation_tokens, $cache_read_tokens,
          $total_input_tokens, $total_output_tokens, $thinking_tokens,
          $ttft_ms, $tps, $usage_missing, $metrics_extracted_at)`,
    );
    this.stmtUpdateVision = this.db.prepare(`
      UPDATE captures SET
        response_status = $status,
        response_headers = $rh,
        response_body = $rb,
        response_size = $rs,
        content_type = $ct,
        is_sse = $sse,
        duration_ms = $dur,
        state = 'done',
        finished_at = $fin,
        status_source = $status_source,
        gate_reason = $gate_reason,
        vision_meta = $vision_meta,
        provider = $provider,
        streaming = $streaming,
        model = $model,
        input_tokens = $input_tokens,
        output_tokens = $output_tokens,
        cache_creation_tokens = $cache_creation_tokens,
        cache_read_tokens = $cache_read_tokens,
        total_input_tokens = $total_input_tokens,
        total_output_tokens = $total_output_tokens,
        thinking_tokens = $thinking_tokens,
        ttft_ms = $ttft_ms,
        tps = $tps,
        usage_missing = $usage_missing,
        metrics_extracted_at = $metrics_extracted_at
      WHERE id = $id
    `);
    this.stmtListVision = this.db.prepare(
      `SELECT id, method, path, response_status, is_sse, content_type,
              request_size, response_size, duration_ms, state, started_at, finished_at,
              incoming_protocol, upstream_protocol, model, usage_missing,
              ttft_ms, tps, input_tokens, output_tokens,
              cache_creation_tokens, cache_read_tokens,
              total_input_tokens, total_output_tokens, is_vision, parent_capture_id,
              status_source, gate_reason
       FROM captures WHERE is_vision = 1
       ORDER BY id DESC LIMIT ?`,
    );
    this.stmtClearVision = this.db.prepare("DELETE FROM captures WHERE is_vision = 1");
    this.stmtListVisionRecords = this.db.prepare(
      `SELECT id, response_body, request_body, vision_meta, started_at, finished_at, parent_capture_id, model,
              state, incoming_protocol, upstream_protocol
       FROM captures WHERE is_vision = 1
       ORDER BY id DESC LIMIT ?`,
    );
    this.visionDescStore = new VisionDescriptionStore(this.db);
    this.rowCount = (this.stmtCount.get() as { c: number }).c;
  }

  /** Mark captures stuck in "streaming" or "enqueued" from a previous run as "done".
   *  Called once on startup so the dashboard doesn't show phantom "running" rows. */
  private sweepStaleCaptures(): void {
    this.db
      .prepare("UPDATE captures SET state = 'done' WHERE state IN ('streaming', 'enqueued')")
      .run();
  }

  /** Insert a new capture row and enforce the ring buffer. Returns the new id. */
  startCapture(params: InsertParams): number {
    const compressed = {
      ...params,
      $rh: compressText(params.$rh, this.compressionEnabled),
      $rb: compressText(params.$rb, this.compressionEnabled),
    };
    let id = 0;
    this.db.transaction(() => {
      id = Number(this.stmtInsert.run(compressed as unknown as never).lastInsertRowid);
      const excess = Math.max(0, ++this.rowCount - this.maxCaptures);
      if (excess > 0) {
        this.stmtDeleteOld.run({ $limit: this.maxCaptures, $excess: excess });
        this.rowCount = this.maxCaptures;
      }
    })();
    return id;
  }

  /** Update a capture row with response data. */
  updateCapture(params: UpdateParams): void {
    const compressed = {
      ...params,
      $rh: compressText(params.$rh, this.compressionEnabled),
      $rb: compressText(params.$rb, this.compressionEnabled),
    };
    this.db.transaction(() => {
      this.stmtUpdate.run(compressed as unknown as never);
      accountCaptureUsage(this.db, params.$id);
    })();
  }

  /** Transition a capture's state (enqueued → streaming → done). */
  setState(id: number, state: "enqueued" | "streaming" | "done"): void {
    this.stmtSetState.run({ $state: state, $id: id });
  }

  /** Update request_body and request_size after in-flight modification (e.g. vision handoff). */
  updateRequestBody(id: number, body: string, size: number): void {
    const compressedBody = compressText(body, this.compressionEnabled);
    this.stmtUpdateRequestBody.run({ $rb: compressedBody, $rs: size, $id: id });
  }

  /** Batch-update multiple captures in a single transaction. */
  async batchUpdate(items: Array<{ id: number; res: Omit<UpdateParams, "$id"> }>): Promise<void> {
    this.db.transaction(() => {
      for (const it of items) {
        this.stmtUpdate.run({
          ...it.res,
          $rh: compressText(it.res.$rh, this.compressionEnabled),
          $rb: compressText(it.res.$rb, this.compressionEnabled),
          ...flattenUsage(it.res.$usage),
          $model: it.res.$model ?? null,
          $id: it.id,
        } as unknown as never);
        accountCaptureUsage(this.db, it.id);
      }
    })();
  }

  /** Get a single capture by id (full row including bodies). */
  get(id: number): CaptureRow | null {
    const raw = this.stmtGet.get({ $id: id }) as Record<string, unknown> | undefined;
    if (!raw) return null;
    const fields: Array<keyof CaptureRow> = [
      "request_headers",
      "request_body",
      "response_headers",
      "response_body",
    ];
    for (const field of fields) {
      const original = raw[field] as string | Uint8Array | null;
      const decompressed = decompressText(original);
      if (decompressed === null && original !== null) {
        CaptureDB.log.warn("decompression returned null for corrupted body", {
          captureId: id,
          field,
        });
      }
      raw[field] = decompressed;
    }
    return raw as unknown as CaptureRow;
  }

  /** List recent capture summaries (no body data). */
  list(limit: number): CaptureRow[] {
    return this.stmtList.all(Math.min(limit, 1000)) as CaptureRow[];
  }

  /** Compute per-model performance stats entirely in SQL (p10/p50/p95, sums, cached%).
   *  Uses the v_latest_requests_per_model view + nearest-rank percentiles.
   *  Returns PerformanceStatsRow[] — no JS post-processing needed. */
  getPerformanceStats(): PerformanceStatsRow[] {
    const rows = this.stmtPerformanceStats.all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      model: row.model as string,
      provider: (row.provider as "anthropic" | "openai") ?? "anthropic",
      request_count: Number(row.request_count) || 0,
      streaming_count: Number(row.streaming_count) || 0,
      total_input_tokens: Number(row.total_input_tokens) || 0,
      total_output_tokens: Number(row.total_output_tokens) || 0,
      total_cache_read_tokens: Number(row.total_cache_read_tokens) || 0,
      total_thinking_tokens: Number(row.total_thinking_tokens) || 0,
      cached_pct: Number(row.cached_pct) || 0,
      ttft_mean: (row.ttft_mean as number | null) ?? null,
      ttft_p10: (row.ttft_p10 as number | null) ?? null,
      ttft_p50: (row.ttft_p50 as number | null) ?? null,
      ttft_p95: (row.ttft_p95 as number | null) ?? null,
      ttft_outlier_count: 0,
      tps_mean: (row.tps_mean as number | null) ?? null,
      tps_p10: (row.tps_p10 as number | null) ?? null,
      tps_p50: (row.tps_p50 as number | null) ?? null,
      tps_p95: (row.tps_p95 as number | null) ?? null,
      tps_outlier_count: 0,
    }));
  }

  /** Delete all captures. */
  clear(): void {
    this.db.prepare("DELETE FROM captures").run();
    this.rowCount = 0;
  }

  /** Insert a vision-call capture row. Returns the new row id. */
  insertVisionCapture(params: VisionInsertParams): number {
    const compressed = {
      ...params,
      $rh: compressText(params.$rh, this.compressionEnabled),
      $rb: compressText(params.$rb, this.compressionEnabled),
      $rh2: compressText(params.$rh2, this.compressionEnabled),
      $rb2: compressText(params.$rb2, this.compressionEnabled),
    };
    let id = 0;
    this.db.transaction(() => {
      id = Number(this.stmtInsertVision.run(compressed as unknown as never).lastInsertRowid);
      const excess = Math.max(0, ++this.rowCount - this.maxCaptures);
      if (excess > 0) {
        this.stmtDeleteOld.run({ $limit: this.maxCaptures, $excess: excess });
        this.rowCount = this.maxCaptures;
      }
    })();
    return id;
  }

  /** Update a vision-call capture row with final response data and mark it done. */
  updateVisionCapture(params: VisionUpdateParams): void {
    const compressed = {
      ...params,
      $rh: compressText(params.$rh, this.compressionEnabled),
      $rb: compressText(params.$rb, this.compressionEnabled),
    };
    this.db.transaction(() => {
      this.stmtUpdateVision.run(compressed as unknown as never);
      accountCaptureUsage(this.db, params.$id);
    })();
  }

  /** List recent vision-call capture summaries (is_vision=1). */
  listVisionCaptures(limit: number): CaptureRow[] {
    return this.stmtListVision.all(Math.min(limit, 1000)) as CaptureRow[];
  }

  /** Delete only vision-call captures (is_vision=1). */
  clearVisionCaptures(): void {
    const deleted = this.stmtClearVision.run();
    this.rowCount = Math.max(0, this.rowCount - (deleted.changes ?? 0));
  }

  /**
   * Reconstruct VisionCallRecord[] from stored vision-call rows.
   * The metadata is persisted as JSON in vision_meta by addRecord().
   */
  getVisionCallRecords(limit: number): VisionCallRecord[] {
    const rows = this.stmtListVisionRecords.all(Math.min(limit, 1000)) as Array<{
      id: number;
      response_body: string | Uint8Array | null;
      request_body: string | Uint8Array | null;
      vision_meta: string | null;
      started_at: number | null;
      finished_at: number | null;
      parent_capture_id: number | null;
      model: string | null;
      state: string | null;
      incoming_protocol: string | null;
      upstream_protocol: string | null;
    }>;
    for (const row of rows) {
      row.response_body = decompressText(row.response_body);
      row.request_body = decompressText(row.request_body);
    }
    const records: VisionCallRecord[] = [];
    for (const row of rows) {
      if (!row.vision_meta) continue;
      try {
        const data = JSON.parse(row.vision_meta) as {
          status: VisionCallRecord["status"];
          httpStatus: number | null;
          latencyMs: number;
          description: string;
          error: string | null;
          imageHash: string | null;
          imageSize: number;
          model: string;
          target: string;
        };
        records.push({
          id: row.id,
          timestamp: row.finished_at ?? row.started_at ?? Date.now(),
          captureId: row.parent_capture_id,
          model: data.model ?? row.model ?? "",
          target: data.target ?? "",
          imageSize: data.imageSize ?? 0,
          imageHash: data.imageHash ?? null,
          status: data.status,
          httpStatus: data.httpStatus ?? null,
          latencyMs: data.latencyMs ?? 0,
          description: data.description ?? "",
          error: data.error ?? null,
          incomingProtocol: row.incoming_protocol ?? "",
          upstreamProtocol: row.upstream_protocol ?? "",
          state: (row.state ?? "done") as CaptureState,
        });
      } catch {
        // Corrupt JSON — skip this row.
      }
    }
    return records;
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  /** Access the raw bun:sqlite Database (for economics queries). */
  get rawDb(): Database {
    return this.db;
  }

  /** Insert or update a vision description in the persistent store. */
  upsertVisionDescription(params: {
    $key: string;
    $image_hash: string;
    $model: string;
    $prompt_version: number;
    $description: string;
    $now: number;
  }): void {
    this.visionDescStore.upsert(params);
  }

  /** Look up a vision description by key. Returns null if not found. */
  getVisionDescription(key: string): { description: string; created_at: number } | null {
    return this.visionDescStore.get(key);
  }

  deleteVisionDescription(key: string): void {
    this.visionDescStore.delete(key);
  }

  evictVisionDescriptions(cutoff: number, maxRows: number): number {
    return this.visionDescStore.evict(cutoff, maxRows);
  }

  /** List recent non-expired vision descriptions for cache warming. Returns up to `limit` entries. */
  listVisionDescriptionsForWarming(
    limit: number,
    cutoff: number,
  ): Array<{ key: string; description: string }> {
    return this.visionDescStore.listForWarming(limit, cutoff);
  }
}
