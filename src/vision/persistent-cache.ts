import type { CaptureDB } from "../db.js";
import { createLogger } from "../logger.js";

const log = createLogger("vision");

export interface PersistentDescriptionEntry {
  key: string;
  description: string;
  imageHash: string;
  model: string;
  promptVersion: number;
}

interface PendingWrite {
  entry: PersistentDescriptionEntry;
  now: number;
}

/**
 * SQLite-backed description store with write-behind batching.
 *
 * Writes are buffered and flushed in batches on a timer (same pattern as
 * `queue.ts` WriteQueue) to avoid blocking the request path with synchronous
 * SQLite writes. Reads check the pending buffer first, then SQLite.
 *
 * WAL mode + single-threaded JS event loop means no lock contention between
 * reads and batched writes — the write-behind queue exists to keep the
 * request path fast, not to avoid lock contention (WAL already handles that).
 */
export class PersistentDescriptionStore {
  private readonly db: CaptureDB;
  private readonly ttlMs: number;
  private readonly maxRows: number;
  private lastEvictionAt = 0;
  private static readonly EVICTION_INTERVAL_MS = 60_000;

  private readonly pendingWrites: PendingWrite[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly flushIntervalMs: number;
  private readonly flushBatch: number;
  private closed = false;
  private flushRetries = 0;
  private static readonly MAX_FLUSH_RETRIES = 3;

  constructor(db: CaptureDB, ttlMs: number, maxRows: number, flushBatch = 50) {
    this.db = db;
    this.ttlMs = ttlMs;
    this.maxRows = maxRows;
    this.flushIntervalMs = 500;
    this.flushBatch = flushBatch;
  }

  get(key: string): string | null {
    for (let i = this.pendingWrites.length - 1; i >= 0; i--) {
      if (this.pendingWrites[i].entry.key === key) {
        const pw = this.pendingWrites[i];
        if (Date.now() - pw.now > this.ttlMs) return null;
        return pw.entry.description;
      }
    }
    const row = this.db.getVisionDescription(key);
    if (!row) return null;
    const now = Date.now();
    if (now - row.created_at > this.ttlMs) {
      return null;
    }
    return row.description;
  }

  set(entry: PersistentDescriptionEntry): void {
    const now = Date.now();
    this.pendingWrites.push({ entry, now });
    if (this.pendingWrites.length >= this.flushBatch) {
      if (this.flushTimer) {
        clearTimeout(this.flushTimer);
        this.flushTimer = null;
      }
      this.flushNow();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        try {
          this.flushNow();
        } catch {
          // DB may be closed during shutdown; pending writes are lost
        }
      }, this.flushIntervalMs);
    }
    this.maybeEvict(now);
  }

  flushNow(): void {
    this.flushTimer = null;
    if (this.closed || this.pendingWrites.length === 0) return;
    const batch = this.pendingWrites.splice(0, this.pendingWrites.length);
    try {
      this.db.transaction(() => {
        for (const pw of batch) {
          this.db.upsertVisionDescription({
            $key: pw.entry.key,
            $image_hash: pw.entry.imageHash,
            $model: pw.entry.model,
            $prompt_version: pw.entry.promptVersion,
            $description: pw.entry.description,
            $now: pw.now,
          });
        }
      })();
      this.flushRetries = 0;
    } catch (err) {
      this.flushRetries += 1;
      const keys = batch.map((pw) => pw.entry.key);
      if (this.flushRetries >= PersistentDescriptionStore.MAX_FLUSH_RETRIES) {
        log.warn("flush retries exhausted, dropping batch", {
          count: batch.length,
          keys,
          retries: this.flushRetries,
          error: err instanceof Error ? err.message : String(err),
        });
        this.flushRetries = 0;
      } else {
        log.error("flush failed, re-queuing batch", {
          count: batch.length,
          keys,
          retries: this.flushRetries,
          error: err instanceof Error ? err.message : String(err),
        });
        this.pendingWrites.unshift(...batch);
      }
    }
  }

  close(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    try {
      this.flushNow();
    } catch (err) {
      log.error("flush failed during close", { error: err });
    } finally {
      this.closed = true;
    }
  }

  warmIntoCache(onEntry: (key: string, description: string) => void, limit: number): number {
    this.flushNow();
    const cutoff = Date.now() - this.ttlMs;
    const rows = this.db.listVisionDescriptionsForWarming(limit, cutoff);
    let count = 0;
    for (const row of rows) {
      onEntry(row.key, row.description);
      count++;
    }
    return count;
  }

  private maybeEvict(now: number): void {
    if (now - this.lastEvictionAt < PersistentDescriptionStore.EVICTION_INTERVAL_MS) return;
    this.lastEvictionAt = now;
    const cutoff = now - this.ttlMs;
    this.db.evictVisionDescriptions(cutoff, this.maxRows);
  }
}
