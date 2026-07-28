// SQLite capture store using bun:sqlite.
// WAL mode + write-behind queue for non-blocking captures.

import { Database } from "bun:sqlite";
import { chmodSync, existsSync } from "node:fs";
import { compressText, decompressText } from "./compress.js";
import { accountCapturesUsage, backfillFromCaptures, migrateEconomicsSchema } from "./economics.js";
import { createLogger } from "./logger.js";
import type { CaptureRow, CaptureState, ProxyConfig } from "./types.js";
import type { PerformanceStatsRow, UsageMetrics } from "./usage-extract.js";
import { PERFORMANCE_STATS_SQL, USAGE_COLUMNS_DDL } from "./usage-extract.js";
import type { VisionCallRecord } from "./vision/handoff.js";
import { VisionDescriptionStore } from "./vision-description-store.js";

function restrictDbFilePermissions(dbPath: string): void {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (existsSync(p)) {
        chmodSync(p, 0o600);
      }
    } catch (e) {
      console.warn(`[db] failed to chmod 0600 on ${p}:`, e);
    }
  }
}

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
  $retry_attempt?: number | null;
  $ttft_exceeded?: number | null;
  $upstream_ttft_p50_ms?: number | null;
  $upstream_tps_p50?: number | null;
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
  $thinking_block_count: number | null;
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
  $reqBody: string;
  $reqHeaders: string;
  $reqSize: number;
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
  $thinking_block_count: number | null;
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
      $thinking_block_count: null,
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
    $thinking_block_count: usage.thinking_block_count,
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
  db.exec("PRAGMA foreign_keys = ON;");

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
  // TTFT retry visibility: retry count (0=no retry, 1=same-key, 2=rewrite escalation)
  // and whether the watchdog fired on any attempt.
  addColumnIfMissing(db, "retry_attempt", "INTEGER");
  addColumnIfMissing(db, "ttft_exceeded", "INTEGER");
  // Upstream p50 TTFT and TPS for the dynamic-threshold watchdog (ticket 02).
  // Nullable: populated by ticket 03; null until status data is fetched.
  addColumnIfMissing(db, "upstream_ttft_p50_ms", "INTEGER");
  addColumnIfMissing(db, "upstream_tps_p50", "REAL");

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

  // Sub-1-second captures intentionally keep tps NULL so aggregate TPS only
  // averages true rates. The dashboard display falls back to the raw output
  // token count when generation time is under one second.

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
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_vision_desc_image_hash
        ON vision_descriptions(image_hash);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS id_rewrite_sessions (
      session_id        TEXT PRIMARY KEY,
      harness           TEXT NOT NULL,
      salt              TEXT NOT NULL,
      salt_version      INTEGER NOT NULL DEFAULT 1,
      first_seen_at     INTEGER NOT NULL,
      last_502_at       INTEGER NOT NULL,
      consecutive_502s  INTEGER NOT NULL DEFAULT 0,
      expires_at        INTEGER NOT NULL,
      last_request_size INTEGER,
      last_error_body   TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_id_rewrite_sessions_expires
      ON id_rewrite_sessions(expires_at ASC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS id_rewrite_mappings (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id     TEXT NOT NULL,
      salt_version   INTEGER NOT NULL,
      original_id    TEXT NOT NULL,
      rewritten_id   TEXT NOT NULL,
      id_type        TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      UNIQUE(session_id, original_id, id_type, salt_version),
      FOREIGN KEY (session_id) REFERENCES id_rewrite_sessions(session_id) ON DELETE CASCADE
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_id_rewrite_mappings_lookup
      ON id_rewrite_mappings(session_id, original_id, id_type);
  `);

  // Drop id_rewrite_audit if it has the old FK constraint (ring buffer eviction breaks with FK on capture_id).
  // Safe to drop: transient audit data, recreated without FK below.
  const auditFkCheck = db
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='id_rewrite_audit'")
    .get() as { sql: string } | null;
  if (auditFkCheck?.sql?.includes("FOREIGN KEY")) {
    db.exec("DROP TABLE IF EXISTS id_rewrite_audit");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS id_rewrite_audit (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_id     INTEGER NOT NULL,
      session_id     TEXT,
      rewritten_at   INTEGER NOT NULL,
      salt_version   INTEGER NOT NULL,
      fields_rewritten TEXT NOT NULL,
      tool_use_ids_rewritten INTEGER DEFAULT 0
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_id_rewrite_audit_capture
      ON id_rewrite_audit(capture_id);
  `);

  // Incidents table — one row per non-200 capture, attributed at first write site.
  // No FOREIGN KEY on capture_id: incidents have an independent lifecycle and are
  // purged only by sweepIncidents() when they exceed incident_retention_days.
  // Ring-buffer eviction of captures does NOT touch incidents.
  db.exec(`
    CREATE TABLE IF NOT EXISTS incidents (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      capture_id        INTEGER NOT NULL UNIQUE,
      responsible_party TEXT NOT NULL,
      incident_type     TEXT NOT NULL,
      upstream_status   INTEGER,
      served_status     INTEGER NOT NULL,
      reason            TEXT,
      retry_attempt     INTEGER,
      ttft_exceeded     INTEGER,
      created_at        INTEGER NOT NULL
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_incidents_created
      ON incidents(created_at DESC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_incidents_party
      ON incidents(responsible_party, created_at DESC);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_incidents_type
      ON incidents(incident_type, created_at DESC);
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
  private stmtUpdateP50: ReturnType<Database["prepare"]>;
  private stmtGetP50: ReturnType<Database["prepare"]>;
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
  performanceSampleLimit: number;
  incidentRetentionDays: number;
  onPrune: ((prunedIds: number[]) => void) | null = null;

  constructor(
    config: Pick<ProxyConfig, "dbPath" | "maxCaptures"> &
      Partial<
        Pick<ProxyConfig, "compressionEnabled" | "performanceSampleCount"> & {
          incidentRetentionDays?: number;
        }
      >,
  ) {
    this.db = new Database(config.dbPath);
    this.maxCaptures = config.maxCaptures;
    this.compressionEnabled = config.compressionEnabled ?? true;
    this.performanceSampleLimit = config.performanceSampleCount ?? 200;
    this.incidentRetentionDays = config.incidentRetentionDays ?? 30;

    migrateCaptureSchema(this.db);
    restrictDbFilePermissions(config.dbPath);

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
        thinking_block_count   = $thinking_block_count,
        ttft_ms                = $ttft_ms,
        tps                    = $tps,
        usage_missing          = $usage_missing,
        metrics_extracted_at   = $metrics_extracted_at,
        retry_attempt          = $retry_attempt,
        ttft_exceeded          = $ttft_exceeded,
        upstream_ttft_p50_ms   = COALESCE($upstream_ttft_p50_ms, upstream_ttft_p50_ms),
        upstream_tps_p50       = COALESCE($upstream_tps_p50, upstream_tps_p50)
      WHERE id = $id
    `);
    this.stmtDeleteOld = this.db.prepare(
      "DELETE FROM captures WHERE id IN (SELECT id FROM captures ORDER BY id DESC LIMIT $excess OFFSET $limit)",
    );
    this.sweepStaleCaptures();
    this.sweepIncidents();
    this.stmtGet = this.db.prepare("SELECT * FROM captures WHERE id = $id");
    this.stmtList = this.db.prepare(
      `SELECT id, method, path, response_status, is_sse, content_type,
              request_size, response_size, duration_ms, state, started_at, finished_at,
              incoming_protocol, upstream_protocol, model, usage_missing,
              ttft_ms, tps, input_tokens, output_tokens,
              cache_creation_tokens, cache_read_tokens,
              total_input_tokens, total_output_tokens, is_vision,
              status_source, gate_reason, retry_attempt, ttft_exceeded,
              upstream_ttft_p50_ms, upstream_tps_p50
       FROM captures ORDER BY id DESC LIMIT ?`,
    );
    this.stmtCount = this.db.prepare("SELECT COUNT(*) AS c FROM captures");
    this.stmtSetState = this.db.prepare("UPDATE captures SET state = $state WHERE id = $id");
    this.stmtUpdateRequestBody = this.db.prepare(
      "UPDATE captures SET request_body = $rb, request_size = $rs WHERE id = $id",
    );
    this.stmtUpdateP50 = this.db.prepare(
      "UPDATE captures SET upstream_ttft_p50_ms = $ttft, upstream_tps_p50 = $tps WHERE id = $id",
    );
    this.stmtGetP50 = this.db.prepare(
      "SELECT upstream_ttft_p50_ms, upstream_tps_p50 FROM captures WHERE id = $id",
    ) as ReturnType<Database["prepare"]>;
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
          thinking_block_count,
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
          $thinking_block_count,
          $ttft_ms, $tps, $usage_missing, $metrics_extracted_at)`,
    );
    this.stmtUpdateVision = this.db.prepare(`
      UPDATE captures SET
        response_status = $status,
        response_headers = $rh,
        response_body = $rb,
        response_size = $rs,
        request_body = $reqBody,
        request_headers = $reqHeaders,
        request_size = $reqSize,
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
        thinking_block_count = $thinking_block_count,
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
    let prunedIds: number[] = [];
    this.db.transaction(() => {
      id = Number(this.stmtInsert.run(compressed as unknown as never).lastInsertRowid);
      const excess = Math.max(0, ++this.rowCount - this.maxCaptures);
      if (excess > 0) {
        const rows = this.db
          .prepare("SELECT id FROM captures ORDER BY id DESC LIMIT $excess OFFSET $limit")
          .all({ $limit: this.maxCaptures, $excess: excess }) as { id: number }[];
        prunedIds = rows.map((r) => r.id);
        this.stmtDeleteOld.run({ $limit: this.maxCaptures, $excess: excess });
        this.rowCount = this.maxCaptures;
      }
    })();
    if (prunedIds.length > 0) {
      this.onPrune?.(prunedIds);
    }
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
      accountCapturesUsage(this.db, [params.$id]);
    })();
  }

  /** Transition a capture's state (enqueued → streaming → done). */
  setState(id: number, state: CaptureState): void {
    this.stmtSetState.run({ $state: state, $id: id });
  }

  /** Update request_body and request_size after in-flight modification (e.g. vision handoff). */
  updateRequestBody(id: number, body: string, size: number): void {
    const compressedBody = compressText(body, this.compressionEnabled);
    this.stmtUpdateRequestBody.run({ $rb: compressedBody, $rs: size, $id: id });
  }

  /** Update only the upstream p50 TTFT/TPS columns for a capture row. */
  updateUpstreamP50(id: number, ttftP50: number | null, tpsP50: number | null): void {
    this.stmtUpdateP50.run({ $ttft: ttftP50, $tps: tpsP50, $id: id });
  }

  getUpstreamP50(
    id: number,
  ): { upstream_ttft_p50_ms: number | null; upstream_tps_p50: number | null } | null {
    const row = this.stmtGetP50.get({ $id: id }) as
      | { upstream_ttft_p50_ms: number | null; upstream_tps_p50: number | null }
      | undefined;
    return row ?? null;
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
          $upstream_ttft_p50_ms: it.res.$upstream_ttft_p50_ms ?? null,
          $upstream_tps_p50: it.res.$upstream_tps_p50 ?? null,
          $id: it.id,
        } as unknown as never);
      }
      accountCapturesUsage(
        this.db,
        items.map((it) => it.id),
      );
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
        const originalLength = typeof original === "string" ? original.length : original.byteLength;
        CaptureDB.log.warn("decompression returned null for corrupted body", {
          captureId: id,
          field,
          originalLength,
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
   *  Uses nearest-rank percentiles over the latest N done requests per model,
   *  where N is controlled by `performanceSampleLimit` (hot-reloadable).
   *  Returns PerformanceStatsRow[] — no JS post-processing needed. */
  getPerformanceStats(): PerformanceStatsRow[] {
    const rows = this.stmtPerformanceStats.all({ $limit: this.performanceSampleLimit }) as Array<
      Record<string, unknown>
    >;
    return rows.map((row) => ({
      model: row.model as string,
      provider: (row.provider as "anthropic" | "openai") ?? "anthropic",
      request_count: Number(row.request_count) || 0,
      streaming_count: Number(row.streaming_count) || 0,
      total_input_tokens: Number(row.total_input_tokens) || 0,
      total_output_tokens: Number(row.total_output_tokens) || 0,
      total_cache_read_tokens: Number(row.total_cache_read_tokens) || 0,
      total_thinking_tokens: Number(row.total_thinking_tokens) || 0,
      requests_with_thinking: Number(row.requests_with_thinking) || 0,
      cached_pct: Number(row.cached_pct) || 0,
      ttft_mean: (row.ttft_mean as number | null) ?? null,
      ttft_max: (row.ttft_max as number | null) ?? null,
      ttft_p10: (row.ttft_p10 as number | null) ?? null,
      ttft_p50: (row.ttft_p50 as number | null) ?? null,
      ttft_p95: (row.ttft_p95 as number | null) ?? null,
      ttft_outlier_count: 0,
      tps_mean: (row.tps_mean as number | null) ?? null,
      tps_min: (row.tps_min as number | null) ?? null,
      tps_p10: (row.tps_p10 as number | null) ?? null,
      tps_p50: (row.tps_p50 as number | null) ?? null,
      tps_p95: (row.tps_p95 as number | null) ?? null,
      tps_outlier_count: 0,
    }));
  }

  /** Delete all captures. Incidents are preserved (expire via sweepIncidents). */
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
    let prunedIds: number[] = [];
    this.db.transaction(() => {
      id = Number(this.stmtInsertVision.run(compressed as unknown as never).lastInsertRowid);
      const excess = Math.max(0, ++this.rowCount - this.maxCaptures);
      if (excess > 0) {
        const rows = this.db
          .prepare("SELECT id FROM captures ORDER BY id DESC LIMIT $excess OFFSET $limit")
          .all({ $limit: this.maxCaptures, $excess: excess }) as { id: number }[];
        prunedIds = rows.map((r) => r.id);
        this.stmtDeleteOld.run({ $limit: this.maxCaptures, $excess: excess });
        this.rowCount = this.maxCaptures;
      }
    })();
    if (prunedIds.length > 0) {
      this.onPrune?.(prunedIds);
    }
    return id;
  }

  /** Update a vision-call capture row with final response data and mark it done. */
  updateVisionCapture(params: VisionUpdateParams): void {
    const compressed = {
      ...params,
      $rh: compressText(params.$rh, this.compressionEnabled),
      $rb: compressText(params.$rb, this.compressionEnabled),
      $reqBody: compressText(params.$reqBody, this.compressionEnabled),
      $reqHeaders: compressText(params.$reqHeaders, this.compressionEnabled),
    };
    this.db.transaction(() => {
      this.stmtUpdateVision.run(compressed as unknown as never);
      accountCapturesUsage(this.db, [params.$id]);
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

  /**
   * Wrap `fn` in a single SQLite transaction. Returns a function that, when
   * called, executes `fn` within BEGIN/COMMIT (or ROLLBACK on throw).
   */
  transaction<T>(fn: () => T): () => T {
    return this.db.transaction(fn);
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

  recordIdRewriteSession(params: {
    sessionId: string;
    harness: string;
    salt: string;
    ttlMs: number;
    requestSize: number | null;
    errorBody: string | null;
  }): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO id_rewrite_sessions (session_id, harness, salt, salt_version, first_seen_at, last_502_at, consecutive_502s, expires_at, last_request_size, last_error_body)
         VALUES ($sid, $harness, $salt, 1, $now, $now, 1, $exp, $rs, $eb)
         ON CONFLICT(session_id) DO UPDATE SET
           last_502_at = $now,
           consecutive_502s = consecutive_502s + 1,
           last_request_size = $rs,
           last_error_body = $eb`,
      )
      .run({
        $sid: params.sessionId,
        $harness: params.harness,
        $salt: params.salt,
        $now: now,
        $exp: now + params.ttlMs,
        $rs: params.requestSize,
        $eb: params.errorBody,
      });
  }

  getIdRewriteSession(sessionId: string): {
    salt: string;
    saltVersion: number;
    consecutive502s: number;
    expiresAt: number;
  } | null {
    const row = this.db
      .prepare(
        "SELECT salt, salt_version as saltVersion, consecutive_502s as consecutive502s, expires_at as expiresAt FROM id_rewrite_sessions WHERE session_id = ?",
      )
      .get(sessionId) as {
      salt: string;
      saltVersion: number;
      consecutive502s: number;
      expiresAt: number;
    } | null;
    return row ?? null;
  }

  escalateRewriteSalt(sessionId: string, newSalt: string): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE id_rewrite_sessions SET salt = $salt, salt_version = salt_version + 1, last_502_at = $now WHERE session_id = $sid",
      )
      .run({ $sid: sessionId, $salt: newSalt, $now: now });
  }

  clearIdRewriteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM id_rewrite_mappings WHERE session_id = ?").run(sessionId);
    this.db.prepare("DELETE FROM id_rewrite_sessions WHERE session_id = ?").run(sessionId);
  }

  getRewriteMapping(
    sessionId: string,
    originalId: string,
    idType: string,
    saltVersion: number,
  ): string | null {
    const row = this.db
      .prepare(
        "SELECT rewritten_id as rewrittenId FROM id_rewrite_mappings WHERE session_id = $sid AND original_id = $oid AND id_type = $type AND salt_version = $sv",
      )
      .get({
        $sid: sessionId,
        $oid: originalId,
        $type: idType,
        $sv: saltVersion,
      }) as { rewrittenId: string } | null;
    return row?.rewrittenId ?? null;
  }

  setRewriteMapping(params: {
    sessionId: string;
    originalId: string;
    rewrittenId: string;
    idType: string;
    saltVersion: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO id_rewrite_mappings (session_id, original_id, rewritten_id, id_type, salt_version, created_at)
         VALUES ($sid, $oid, $rid, $type, $sv, $now)`,
      )
      .run({
        $sid: params.sessionId,
        $oid: params.originalId,
        $rid: params.rewrittenId,
        $type: params.idType,
        $sv: params.saltVersion,
        $now: Date.now(),
      });
  }

  pruneExpiredRewriteSessions(): number {
    const now = Date.now();
    this.db
      .prepare(
        "DELETE FROM id_rewrite_mappings WHERE session_id IN (SELECT session_id FROM id_rewrite_sessions WHERE expires_at < ?)",
      )
      .run(now);
    const result = this.db.prepare("DELETE FROM id_rewrite_sessions WHERE expires_at < ?").run(now);
    return Number(result.changes);
  }

  recordIdRewriteAudit(params: {
    captureId: number;
    sessionId: string | null;
    saltVersion: number;
    fieldsRewritten: string[];
    toolUseIdsRewritten: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO id_rewrite_audit (capture_id, session_id, rewritten_at, salt_version, fields_rewritten, tool_use_ids_rewritten)
         VALUES ($cid, $sid, $now, $sv, $fields, $tool_count)`,
      )
      .run({
        $cid: params.captureId,
        $sid: params.sessionId,
        $now: Date.now(),
        $sv: params.saltVersion,
        $fields: params.fieldsRewritten.join(","),
        $tool_count: params.toolUseIdsRewritten,
      });
  }

  /** Insert or update an incident row. Direct sync write (bypasses WriteQueue
   *  per ADR-0022). ON CONFLICT(capture_id) updates only mutable columns —
   *  responsible_party and incident_type are anchored at first insert
   *  (ADR-0021) and never overwritten. */
  recordIncident(params: {
    captureId: number;
    responsibleParty: "upstream" | "proxy" | "client";
    incidentType:
      | "upstream_error"
      | "ttft_timeout"
      | "id_rewrite"
      | "rate_limited"
      | "gate_rejected"
      | "client_aborted";
    upstreamStatus: number | null;
    servedStatus: number;
    reason: string | null;
    retryAttempt?: number | null;
    ttftExceeded?: number | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO incidents
           (capture_id, responsible_party, incident_type, upstream_status,
            served_status, reason, retry_attempt, ttft_exceeded, created_at)
         VALUES ($capture_id, $responsible_party, $incident_type, $upstream_status,
                 $served_status, $reason, $retry_attempt, $ttft_exceeded, $created_at)
         ON CONFLICT(capture_id) DO UPDATE SET
           served_status = excluded.served_status,
           reason = excluded.reason,
           upstream_status = COALESCE(excluded.upstream_status, incidents.upstream_status)`,
      )
      .run({
        $capture_id: params.captureId,
        $responsible_party: params.responsibleParty,
        $incident_type: params.incidentType,
        $upstream_status: params.upstreamStatus,
        $served_status: params.servedStatus,
        $reason: params.reason,
        $retry_attempt: params.retryAttempt ?? null,
        $ttft_exceeded: params.ttftExceeded ?? null,
        $created_at: Date.now(),
      });
  }

  /** Delete incident rows older than `cutoffMs`. When omitted, uses the
   *  configured retention window. Real retention wiring (startup sweep,
   *  eviction cleanup) is in ticket 03. */
  sweepIncidents(cutoffMs?: number): number {
    const cutoff = cutoffMs ?? Date.now() - this.incidentRetentionDays * 86_400_000;
    const result = this.db
      .prepare("DELETE FROM incidents WHERE created_at < $cutoff")
      .run({ $cutoff: cutoff });
    return Number(result.changes);
  }
}
