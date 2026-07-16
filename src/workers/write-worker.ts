/// <reference lib="webworker" />
// Write-behind worker for batch capture updates.
// Opens its own bun:sqlite connection to the same WAL file.
// Receives batched update messages from the main thread and executes
// them in a single transaction, keeping the event loop unblocked.

import { Database } from "bun:sqlite";
import { compressText } from "../compress.js";
import { flattenUsage, migrateCaptureSchema } from "../db.js";
import type { UpdateParams } from "../db.js";
import { accountCapturesUsage, migrateEconomicsSchema } from "../economics.js";

interface BatchMessage {
  type: "batch";
  batchId: number;
  items: Array<{ id: number; res: Omit<UpdateParams, "$id"> }>;
  compressionEnabled: boolean;
}

interface CloseMessage {
  type: "close";
}

type WorkerMessage = BatchMessage | CloseMessage;

let db: Database | null = null;
let stmtUpdate: ReturnType<Database["prepare"]> | null = null;

function ensureConnection(dbPath: string): void {
  if (db) return;
  db = new Database(dbPath);
  migrateCaptureSchema(db);
  migrateEconomicsSchema(db);
  stmtUpdate = db.prepare(`
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
}

function executeBatch(
  items: Array<{ id: number; res: Omit<UpdateParams, "$id"> }>,
  compressionEnabled: boolean,
): void {
  if (!db || !stmtUpdate) return;
  db.transaction(() => {
    for (const it of items) {
      stmtUpdate!.run({
        ...it.res,
        $rh: compressText(it.res.$rh, compressionEnabled),
        $rb: compressText(it.res.$rb, compressionEnabled),
        ...flattenUsage(it.res.$usage),
        $model: it.res.$model ?? null,
        $id: it.id,
      } as unknown as never);
    }
    accountCapturesUsage(
      db!,
      items.map((it) => it.id),
    );
  })();
}

self.onmessage = (e: MessageEvent<WorkerMessage & { dbPath: string }>) => {
  const msg = e.data;
  if (msg.type === "close") {
    db?.close();
    db = null;
    stmtUpdate = null;
    return;
  }
  if (msg.type === "batch") {
    if (!db) {
      ensureConnection(msg.dbPath);
    }
    try {
      executeBatch(msg.items, msg.compressionEnabled);
      self.postMessage({ type: "ack", batchId: msg.batchId, count: msg.items.length });
    } catch (err) {
      self.postMessage({
        type: "error",
        batchId: msg.batchId,
        error: (err as Error).message,
        count: msg.items.length,
      });
    }
  }
};
