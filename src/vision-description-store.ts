// SQLite-backed persistent store for vision descriptions.
// Extracted from CaptureDB to isolate the vision-description cache lifecycle
// (upsert / get / delete / evict / warming-list) from capture persistence.

import type { Database } from "bun:sqlite";

type PreparedStatement = ReturnType<Database["prepare"]>;

/** Parameters for upsertVisionDescription. */
export interface VisionDescriptionUpsertParams {
  $key: string;
  $image_hash: string;
  $model: string;
  $prompt_version: number;
  $description: string;
  $now: number;
}

/**
 * Persistent vision-description store backed by the `vision_descriptions`
 * SQLite table. The table is created/managed by CaptureDB's schema migration;
 * this class only owns the prepared statements and method bodies that operate
 * on that table.
 */
export class VisionDescriptionStore {
  private readonly db: Database;
  private readonly stmtInsert: PreparedStatement;
  private readonly stmtGet: PreparedStatement;
  private readonly stmtTouch: PreparedStatement;
  private readonly stmtDelete: PreparedStatement;
  private readonly stmtEvict: PreparedStatement;
  private readonly stmtCount: PreparedStatement;
  private readonly stmtListForWarming: PreparedStatement;

  constructor(db: Database) {
    this.db = db;
    this.stmtInsert = db.prepare(
      `INSERT INTO vision_descriptions (key, image_hash, model, prompt_version, description, created_at, last_accessed_at)
       VALUES ($key, $image_hash, $model, $prompt_version, $description, $now, $now)
       ON CONFLICT(key) DO UPDATE SET
         description = excluded.description,
         created_at = excluded.created_at,
         last_accessed_at = excluded.last_accessed_at`,
    );
    this.stmtGet = db.prepare(
      "SELECT description, created_at FROM vision_descriptions WHERE key = $key",
    );
    this.stmtTouch = db.prepare(
      "UPDATE vision_descriptions SET last_accessed_at = $now WHERE key = $key",
    );
    this.stmtDelete = db.prepare("DELETE FROM vision_descriptions WHERE key = $key");
    this.stmtEvict = db.prepare(
      `DELETE FROM vision_descriptions
       WHERE key IN (
         SELECT key FROM vision_descriptions
         WHERE created_at < $cutoff
         ORDER BY last_accessed_at ASC
         LIMIT $n
       )`,
    );
    this.stmtCount = db.prepare("SELECT COUNT(*) AS c FROM vision_descriptions");
    this.stmtListForWarming = db.prepare(
      `SELECT key, description FROM vision_descriptions
       WHERE created_at > $cutoff
       ORDER BY last_accessed_at DESC
       LIMIT $n`,
    );
  }

  /** Insert or update a vision description in the persistent store. */
  upsert(params: VisionDescriptionUpsertParams): void {
    this.stmtInsert.run(params as unknown as never);
  }

  /** Look up a vision description by key. Returns null if not found.
   *  Updates last_accessed_at on hit. */
  get(key: string): { description: string; created_at: number } | null {
    const row = this.stmtGet.get({ $key: key }) as
      | { description: string; created_at: number }
      | undefined;
    if (!row) return null;
    this.stmtTouch.run({ $key: key, $now: Date.now() });
    return row;
  }

  delete(key: string): void {
    this.stmtDelete.run({ $key: key });
  }

  /** Evict expired entries (created_at < cutoff) and enforce a max row ceiling.
   *  Returns the number of rows deleted. */
  evict(cutoff: number, maxRows: number): number {
    let deleted = 0;
    this.db.transaction(() => {
      const expiredRes = this.stmtEvict.run({ $cutoff: cutoff, $n: 1000 }) as {
        changes: number;
      };
      deleted += expiredRes.changes;
      const count = (this.stmtCount.get() as { c: number }).c;
      if (count > maxRows) {
        const excess = count - maxRows;
        const overflowRes = this.db
          .prepare(
            "DELETE FROM vision_descriptions WHERE key IN (SELECT key FROM vision_descriptions ORDER BY last_accessed_at ASC LIMIT ?)",
          )
          .run(excess) as { changes: number };
        deleted += overflowRes.changes;
      }
    })();
    return deleted;
  }

  /** List recent non-expired vision descriptions for cache warming.
   *  Returns up to `limit` entries. */
  listForWarming(limit: number, cutoff: number): Array<{ key: string; description: string }> {
    return this.stmtListForWarming.all({ $n: limit, $cutoff: cutoff }) as Array<{
      key: string;
      description: string;
    }>;
  }
}
