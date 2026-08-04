// Economics module — persistent daily usage accumulation + model pricing sync.
//
// This module provides:
//   - model_pricing table: stores per-model pricing (synced from /v1/models API)
//   - daily_usage table: accumulates per-day, per-model token totals + costs
//   - Captures usage_accounted flag on the captures table for idempotent accounting
//
// Design constraints (from user):
//   1. Centralized sync: piggyback on existing ModelsClient poll — no extra API calls.
//   2. Price-as-of-day: costs are frozen at accumulation time; historical rows are
//      never recomputed when pricing changes.
//   3. New model mitigation: unknown models accumulate with $0 cost + pricing_known=0;
//      when sync discovers pricing, those rows are backfilled once.

import type { Database } from "bun:sqlite";
import { createLogger } from "./logger.js";
import type { ModelEntry } from "./models.js";

const log = createLogger("economics");

/** Ratio of cache_read price to input price (derived from Umans pricing page). */
const CACHE_READ_RATIO = 0.186;

/** Seed pricing for known Umans models (used when API hasn't returned pricing yet). */
const SEED_PRICING: Record<string, { input: number; output: number; cache_read: number }> = {
  "umans-glm-5.2": { input: 1.4, output: 4.4, cache_read: 0.26 },
  "umans-kimi-k2.7": { input: 0.95, output: 4.0, cache_read: 0.19 },
  "umans-coder": { input: 0.95, output: 4.0, cache_read: 0.19 },
  "umans-flash": { input: 0.15, output: 1.0, cache_read: 0.05 },
  "umans-qwen3.6-35b-a3b": { input: 0.15, output: 1.0, cache_read: 0.05 },
  "umans-deepseek-v4-flash-0731": { input: 0.14, output: 0.28, cache_read: 0.0028 },
};

/** SQL DDL for economics tables. Idempotent — safe to run on every startup. */
export const ECONOMICS_DDL = `
CREATE TABLE IF NOT EXISTS model_pricing (
  model_id              TEXT PRIMARY KEY,
  input_per_mtoken      REAL NOT NULL DEFAULT 0,
  output_per_mtoken     REAL NOT NULL DEFAULT 0,
  cache_read_per_mtoken REAL NOT NULL DEFAULT 0,
  pricing_known         INTEGER NOT NULL DEFAULT 0,
  updated_at            INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS daily_usage (
  date                   TEXT NOT NULL,
  model                  TEXT NOT NULL,
  requests               INTEGER NOT NULL DEFAULT 0,
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  thinking_tokens        INTEGER NOT NULL DEFAULT 0,
  cost_input             REAL NOT NULL DEFAULT 0,
  cost_output            REAL NOT NULL DEFAULT 0,
  cost_cache_read        REAL NOT NULL DEFAULT 0,
  cost_cache_creation    REAL NOT NULL DEFAULT 0,
  cost_total             REAL NOT NULL DEFAULT 0,
  pricing_known          INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (date, model)
) WITHOUT ROWID;
` as const;

/** SQL to add the usage_accounted column to captures (idempotency flag). */
export const USAGE_ACCOUNTED_DDL =
  "ALTER TABLE captures ADD COLUMN usage_accounted INTEGER DEFAULT 0";

/** Result of a pricing lookup for a single model. */
interface PricingRow {
  input_per_mtoken: number;
  output_per_mtoken: number;
  cache_read_per_mtoken: number;
  pricing_known: number;
}

/** Run economics schema migrations. Idempotent. */
export function migrateEconomicsSchema(db: Database): void {
  db.exec(ECONOMICS_DDL);

  // Add usage_accounted column to captures (no-op if already exists).
  try {
    db.exec(USAGE_ACCOUNTED_DDL);
  } catch {
    // Column already exists — expected for existing DBs.
  }

  // Covering index for unaccounted captures (fast incremental accounting).
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_captures_usage_accounted
      ON captures(usage_accounted, id)
      WHERE usage_accounted = 0;
  `);

  // Seed pricing for known models if model_pricing is empty.
  const count = (db.prepare("SELECT COUNT(*) AS c FROM model_pricing").get() as { c: number }).c;
  if (count === 0) {
    const now = Date.now();
    const stmt = db.prepare(
      `INSERT INTO model_pricing
         (model_id, input_per_mtoken, output_per_mtoken, cache_read_per_mtoken, pricing_known, updated_at)
       VALUES ($model_id, $input, $output, $cache_read, 0, $now)`,
    );
    for (const [modelId, pricing] of Object.entries(SEED_PRICING)) {
      stmt.run({
        $model_id: modelId,
        $input: pricing.input,
        $output: pricing.output,
        $cache_read: pricing.cache_read,
        $now: now,
      });
    }
    log.info(`seeded ${Object.keys(SEED_PRICING).length} model pricing entries`);
  }
}

/** Get pricing for a model, or null if unknown. */
function getPricing(db: Database, modelId: string): PricingRow | null {
  const row = db
    .prepare(
      `SELECT input_per_mtoken, output_per_mtoken, cache_read_per_mtoken, pricing_known
       FROM model_pricing WHERE model_id = $model_id`,
    )
    .get({ $model_id: modelId }) as PricingRow | undefined;
  return row ?? null;
}

/**
 * Account a single capture's usage into daily_usage.
 * Idempotent: only processes captures where usage_accounted=0.
 * Must be called within the same transaction as the capture UPDATE.
 *
 * Costs are computed using current model_pricing at accumulation time
 * and frozen in daily_usage (price-as-of-day constraint).
 */
export function accountCaptureUsage(db: Database, captureId: number): void {
  const capture = db
    .prepare(
      `SELECT model, input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, thinking_tokens, usage_missing, started_at
       FROM captures
       WHERE id = $id AND usage_accounted = 0`,
    )
    .get({ $id: captureId }) as
    | {
        model: string | null;
        input_tokens: number | null;
        output_tokens: number | null;
        cache_read_tokens: number | null;
        cache_creation_tokens: number | null;
        thinking_tokens: number | null;
        usage_missing: number | null;
        started_at: number | null;
      }
    | undefined;

  if (!capture) return; // Already accounted or not found.

  // Skip if no model or usage is missing.
  if (!capture.model || capture.usage_missing) {
    db.prepare("UPDATE captures SET usage_accounted = 1 WHERE id = $id").run({
      $id: captureId,
    });
    return;
  }

  const model = capture.model;
  const startedAt = capture.started_at ?? Date.now();
  const date = new Date(startedAt).toISOString().slice(0, 10); // YYYY-MM-DD

  const inputTokens = capture.input_tokens ?? 0;
  const outputTokens = capture.output_tokens ?? 0;
  const cacheReadTokens = capture.cache_read_tokens ?? 0;
  const cacheCreationTokens = capture.cache_creation_tokens ?? 0;
  const thinkingTokens = capture.thinking_tokens ?? 0;

  // Get pricing (may be null for unknown models).
  const pricing = getPricing(db, model);

  // Compute costs: $ = tokens / 1_000_000 * price_per_mtoken.
  // Unknown models accumulate with $0 cost + pricing_known=0.
  const inputPrice = pricing?.input_per_mtoken ?? 0;
  const outputPrice = pricing?.output_per_mtoken ?? 0;
  const cacheReadPrice = pricing?.cache_read_per_mtoken ?? 0;
  const pricingKnown = pricing?.pricing_known ?? 0;

  // Cache creation is priced at the input rate (Anthropic convention).
  const cacheCreationPrice = inputPrice;

  const costInput = (inputTokens / 1_000_000) * inputPrice;
  const costOutput = (outputTokens / 1_000_000) * outputPrice;
  const costCacheRead = (cacheReadTokens / 1_000_000) * cacheReadPrice;
  const costCacheCreation = (cacheCreationTokens / 1_000_000) * cacheCreationPrice;
  const costTotal = costInput + costOutput + costCacheRead + costCacheCreation;

  // UPSERT into daily_usage (accumulate on conflict).
  db.prepare(
    `INSERT INTO daily_usage
       (date, model, requests, input_tokens, output_tokens,
        cache_read_tokens, cache_creation_tokens, thinking_tokens,
        cost_input, cost_output, cost_cache_read, cost_cache_creation,
        cost_total, pricing_known)
     VALUES
       ($date, $model, 1, $input_tokens, $output_tokens,
        $cache_read_tokens, $cache_creation_tokens, $thinking_tokens,
        $cost_input, $cost_output, $cost_cache_read, $cost_cache_creation,
        $cost_total, $pricing_known)
     ON CONFLICT(date, model) DO UPDATE SET
       requests              = requests + excluded.requests,
       input_tokens          = input_tokens + excluded.input_tokens,
       output_tokens         = output_tokens + excluded.output_tokens,
       cache_read_tokens     = cache_read_tokens + excluded.cache_read_tokens,
       cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
       thinking_tokens       = thinking_tokens + excluded.thinking_tokens,
       cost_input            = cost_input + excluded.cost_input,
       cost_output           = cost_output + excluded.cost_output,
       cost_cache_read       = cost_cache_read + excluded.cost_cache_read,
       cost_cache_creation   = cost_cache_creation + excluded.cost_cache_creation,
       cost_total            = cost_total + excluded.cost_total,
       pricing_known         = excluded.pricing_known`,
  ).run({
    $date: date,
    $model: model,
    $input_tokens: inputTokens,
    $output_tokens: outputTokens,
    $cache_read_tokens: cacheReadTokens,
    $cache_creation_tokens: cacheCreationTokens,
    $thinking_tokens: thinkingTokens,
    $cost_input: costInput,
    $cost_output: costOutput,
    $cost_cache_read: costCacheRead,
    $cost_cache_creation: costCacheCreation,
    $cost_total: costTotal,
    $pricing_known: pricingKnown,
  });

  // Mark capture as accounted.
  db.prepare("UPDATE captures SET usage_accounted = 1 WHERE id = $id").run({
    $id: captureId,
  });
}

/**
 * Batch-account multiple captures' usage into daily_usage.
 * Eliminates the N+1 query pattern of calling accountCaptureUsage in a loop:
 * fetches all captures and pricing in two queries instead of 2N+1.
 *
 * Idempotent: only processes captures where usage_accounted=0.
 * Does NOT start its own transaction — caller must wrap in a transaction
 * if atomicity is needed (existing call sites already do).
 */
export function accountCapturesUsage(db: Database, captureIds: readonly number[]): void {
  if (captureIds.length === 0) return;

  const placeholders = captureIds.map(() => "?").join(",");

  const captures = db
    .prepare(
      `SELECT id, model, input_tokens, output_tokens, cache_read_tokens,
              cache_creation_tokens, thinking_tokens, usage_missing, started_at
       FROM captures
       WHERE id IN (${placeholders}) AND usage_accounted = 0`,
    )
    .all(...captureIds) as Array<{
    id: number;
    model: string | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    thinking_tokens: number | null;
    usage_missing: number | null;
    started_at: number | null;
  }>;

  if (captures.length === 0) return;

  const allIds = captures.map((c) => c.id);
  const needsAccounting = captures.filter((c) => c.model && !c.usage_missing);

  if (needsAccounting.length > 0) {
    const modelSet = new Set<string>();
    for (const c of needsAccounting) {
      if (c.model) modelSet.add(c.model);
    }
    const models = [...modelSet];
    const modelPlaceholders = models.map(() => "?").join(",");
    const pricingRows = db
      .prepare(
        `SELECT model_id, input_per_mtoken, output_per_mtoken,
                cache_read_per_mtoken, pricing_known
         FROM model_pricing WHERE model_id IN (${modelPlaceholders})`,
      )
      .all(...models) as Array<PricingRow & { model_id: string }>;
    const pricingMap = new Map(pricingRows.map((p) => [p.model_id, p]));

    const upsertStmt = db.prepare(
      `INSERT INTO daily_usage
         (date, model, requests, input_tokens, output_tokens,
          cache_read_tokens, cache_creation_tokens, thinking_tokens,
          cost_input, cost_output, cost_cache_read, cost_cache_creation,
          cost_total, pricing_known)
       VALUES
         ($date, $model, 1, $input_tokens, $output_tokens,
          $cache_read_tokens, $cache_creation_tokens, $thinking_tokens,
          $cost_input, $cost_output, $cost_cache_read, $cost_cache_creation,
          $cost_total, $pricing_known)
       ON CONFLICT(date, model) DO UPDATE SET
         requests              = requests + excluded.requests,
         input_tokens          = input_tokens + excluded.input_tokens,
         output_tokens         = output_tokens + excluded.output_tokens,
         cache_read_tokens     = cache_read_tokens + excluded.cache_read_tokens,
         cache_creation_tokens = cache_creation_tokens + excluded.cache_creation_tokens,
         thinking_tokens       = thinking_tokens + excluded.thinking_tokens,
         cost_input            = cost_input + excluded.cost_input,
         cost_output           = cost_output + excluded.cost_output,
         cost_cache_read       = cost_cache_read + excluded.cost_cache_read,
         cost_cache_creation   = cost_cache_creation + excluded.cost_cache_creation,
         cost_total            = cost_total + excluded.cost_total,
         pricing_known         = excluded.pricing_known`,
    );

    for (const capture of needsAccounting) {
      const model = capture.model as string;
      const startedAt = capture.started_at ?? Date.now();
      const date = new Date(startedAt).toISOString().slice(0, 10);

      const inputTokens = capture.input_tokens ?? 0;
      const outputTokens = capture.output_tokens ?? 0;
      const cacheReadTokens = capture.cache_read_tokens ?? 0;
      const cacheCreationTokens = capture.cache_creation_tokens ?? 0;
      const thinkingTokens = capture.thinking_tokens ?? 0;

      const pricing = pricingMap.get(model);
      const inputPrice = pricing?.input_per_mtoken ?? 0;
      const outputPrice = pricing?.output_per_mtoken ?? 0;
      const cacheReadPrice = pricing?.cache_read_per_mtoken ?? 0;
      const pricingKnown = pricing?.pricing_known ?? 0;
      const cacheCreationPrice = inputPrice;

      const costInput = (inputTokens / 1_000_000) * inputPrice;
      const costOutput = (outputTokens / 1_000_000) * outputPrice;
      const costCacheRead = (cacheReadTokens / 1_000_000) * cacheReadPrice;
      const costCacheCreation = (cacheCreationTokens / 1_000_000) * cacheCreationPrice;
      const costTotal = costInput + costOutput + costCacheRead + costCacheCreation;

      upsertStmt.run({
        $date: date,
        $model: model,
        $input_tokens: inputTokens,
        $output_tokens: outputTokens,
        $cache_read_tokens: cacheReadTokens,
        $cache_creation_tokens: cacheCreationTokens,
        $thinking_tokens: thinkingTokens,
        $cost_input: costInput,
        $cost_output: costOutput,
        $cost_cache_read: costCacheRead,
        $cost_cache_creation: costCacheCreation,
        $cost_total: costTotal,
        $pricing_known: pricingKnown,
      });
    }
  }

  const markPlaceholders = allIds.map(() => "?").join(",");
  db.prepare(`UPDATE captures SET usage_accounted = 1 WHERE id IN (${markPlaceholders})`).run(
    ...allIds,
  );
}

/**
 * Backfill daily_usage from existing captures that haven't been accounted yet.
 * Called once on migration. Each capture is accounted individually to ensure
 * correct date bucketing (based on started_at).
 */
export function backfillFromCaptures(db: Database): number {
  const ids = db
    .prepare(
      `SELECT id FROM captures WHERE usage_accounted = 0 AND model IS NOT NULL AND usage_missing = 0
       ORDER BY id ASC`,
    )
    .all() as Array<{ id: number }>;

  let count = 0;
  db.transaction(() => {
    for (const { id } of ids) {
      accountCaptureUsage(db, id);
      count++;
    }
  })();

  if (count > 0) {
    log.info(`backfilled ${count} captures into daily_usage`);
  }
  return count;
}

/**
 * Sync pricing from ModelsClient into model_pricing table.
 * Called periodically — uses models.list() which is a local map lookup (no API call).
 *
 * For each model from the API:
 *   - If exists in model_pricing: update input/output from API, preserve cache_read
 *     (API doesn't return cache_read; we keep the seed value or last known).
 *   - If new: insert with API pricing + estimated cache_read = input * 0.186, pricing_known=0.
 *
 * After syncing, backfill any daily_usage rows that were accumulated with $0 cost
 * (pricing_known=0) for models that now have pricing.
 */
export function syncPricing(
  db: Database,
  models: ModelEntry[],
): {
  updated: number;
  inserted: number;
  backfilled: number;
} {
  const now = Date.now();
  let updated = 0;
  let inserted = 0;

  const upsertStmt = db.prepare(
    `INSERT INTO model_pricing
       (model_id, input_per_mtoken, output_per_mtoken, cache_read_per_mtoken, pricing_known, updated_at)
     VALUES ($model_id, $input, $output, $cache_read, $pricing_known, $now)
     ON CONFLICT(model_id) DO UPDATE SET
       input_per_mtoken      = $input,
       output_per_mtoken     = $output,
       cache_read_per_mtoken = CASE
         WHEN model_pricing.pricing_known = 0 AND $pricing_known = 1 THEN $cache_read
         WHEN model_pricing.cache_read_per_mtoken = 0 THEN $cache_read
         ELSE model_pricing.cache_read_per_mtoken
       END,
       pricing_known         = MAX(model_pricing.pricing_known, $pricing_known),
       updated_at            = $now`,
  );

  db.transaction(() => {
    for (const model of models) {
      if (!model.pricing) continue; // Skip models without pricing data.

      const existing = getPricing(db, model.id);
      const inputPerMtoken = model.pricing.input;
      const outputPerMtoken = model.pricing.output;

      // Estimate cache_read if not already known.
      const estimatedCacheRead = Math.round(inputPerMtoken * CACHE_READ_RATIO * 1000) / 1000;

      if (existing) {
        // Update input/output from API; preserve cache_read if already set.
        const cacheRead =
          existing.cache_read_per_mtoken > 0 ? existing.cache_read_per_mtoken : estimatedCacheRead;
        upsertStmt.run({
          $model_id: model.id,
          $input: inputPerMtoken,
          $output: outputPerMtoken,
          $cache_read: cacheRead,
          $pricing_known: 1,
          $now: now,
        });
        updated++;
      } else {
        // New model — insert with estimated cache_read.
        upsertStmt.run({
          $model_id: model.id,
          $input: inputPerMtoken,
          $output: outputPerMtoken,
          $cache_read: estimatedCacheRead,
          $pricing_known: 1,
          $now: now,
        });
        inserted++;
      }
    }
  })();

  // Backfill daily_usage rows that were accumulated with pricing_known=0
  // for models that now have pricing. This is a one-time correction per model.
  const backfilled = backfillUnpricedDailyUsage(db);

  if (updated + inserted > 0) {
    log.info(
      `pricing sync: ${updated} updated, ${inserted} inserted, ${backfilled} daily_usage rows backfilled`,
    );
  }

  return { updated, inserted, backfilled };
}

/**
 * Backfill daily_usage rows that were accumulated with pricing_known=0
 * (unknown models with $0 cost) for models that now have pricing.
 *
 * Recomputes costs for those rows using current model_pricing.
 * Only affects rows where pricing_known=0 and the model now has pricing.
 */
function backfillUnpricedDailyUsage(db: Database): number {
  // Find daily_usage rows with pricing_known=0 that have a matching model_pricing entry.
  const rows = db
    .prepare(
      `SELECT du.date, du.model, du.requests, du.input_tokens, du.output_tokens,
              du.cache_read_tokens, du.cache_creation_tokens, du.thinking_tokens,
              mp.input_per_mtoken, mp.output_per_mtoken, mp.cache_read_per_mtoken
       FROM daily_usage du
       JOIN model_pricing mp ON du.model = mp.model_id
       WHERE du.pricing_known = 0`,
    )
    .all() as Array<{
    date: string;
    model: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    thinking_tokens: number;
    input_per_mtoken: number;
    output_per_mtoken: number;
    cache_read_per_mtoken: number;
  }>;

  if (rows.length === 0) return 0;

  const updateStmt = db.prepare(
    `UPDATE daily_usage SET
       cost_input          = $cost_input,
       cost_output         = $cost_output,
       cost_cache_read     = $cost_cache_read,
       cost_cache_creation = $cost_cache_creation,
       cost_total          = $cost_total,
       pricing_known       = 1
     WHERE date = $date AND model = $model`,
  );

  db.transaction(() => {
    for (const row of rows) {
      const costInput = (row.input_tokens / 1_000_000) * row.input_per_mtoken;
      const costOutput = (row.output_tokens / 1_000_000) * row.output_per_mtoken;
      const costCacheRead = (row.cache_read_tokens / 1_000_000) * row.cache_read_per_mtoken;
      const costCacheCreation = (row.cache_creation_tokens / 1_000_000) * row.input_per_mtoken;
      const costTotal = costInput + costOutput + costCacheRead + costCacheCreation;

      updateStmt.run({
        $date: row.date,
        $model: row.model,
        $cost_input: costInput,
        $cost_output: costOutput,
        $cost_cache_read: costCacheRead,
        $cost_cache_creation: costCacheCreation,
        $cost_total: costTotal,
      });
    }
  })();

  return rows.length;
}

// ---------------------------------------------------------------------------
// Query functions for the dashboard API
// ---------------------------------------------------------------------------

export interface DailyUsageRow {
  date: string;
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  thinking_tokens: number;
  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_creation: number;
  cost_total: number;
  pricing_known: number;
}

export interface MonthSummary {
  year: number;
  month: number;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  thinking_tokens: number;
  cost_input: number;
  cost_output: number;
  cost_cache_read: number;
  cost_cache_creation: number;
  cost_total: number;
  has_unpriced: boolean;
  per_model: Array<{
    model: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_total: number;
  }>;
}

export interface ModelPricingRow {
  model_id: string;
  input_per_mtoken: number;
  output_per_mtoken: number;
  cache_read_per_mtoken: number;
  pricing_known: number;
  updated_at: number;
}

/** Get daily usage rows (most recent first, limited). */
export function getDailyUsage(db: Database, limit = 90): DailyUsageRow[] {
  const rows = db
    .prepare(
      `SELECT date, model, requests, input_tokens, output_tokens,
              cache_read_tokens, cache_creation_tokens, thinking_tokens,
              cost_input, cost_output, cost_cache_read, cost_cache_creation,
              cost_total, pricing_known
       FROM daily_usage
       ORDER BY date DESC, model ASC
       LIMIT $limit`,
    )
    .all({ $limit: limit }) as DailyUsageRow[];
  return rows;
}

/** Get month summary (totals + per-model breakdown). */
export function getMonthSummary(db: Database, year: number, month: number): MonthSummary {
  const monthPrefix = `${year}-${String(month).padStart(2, "0")}%`;
  const totals = db
    .prepare(
      `SELECT
         COUNT(*) as request_count,
         SUM(requests) as requests,
         SUM(input_tokens) as input_tokens,
         SUM(output_tokens) as output_tokens,
         SUM(cache_read_tokens) as cache_read_tokens,
         SUM(cache_creation_tokens) as cache_creation_tokens,
         SUM(thinking_tokens) as thinking_tokens,
         SUM(cost_input) as cost_input,
         SUM(cost_output) as cost_output,
         SUM(cost_cache_read) as cost_cache_read,
         SUM(cost_cache_creation) as cost_cache_creation,
         SUM(cost_total) as cost_total,
         MAX(CASE WHEN pricing_known = 0 THEN 1 ELSE 0 END) as has_unpriced
       FROM daily_usage
       WHERE date LIKE $prefix`,
    )
    .get({ $prefix: monthPrefix }) as {
    request_count: number;
    requests: number | null;
    input_tokens: number | null;
    output_tokens: number | null;
    cache_read_tokens: number | null;
    cache_creation_tokens: number | null;
    thinking_tokens: number | null;
    cost_input: number | null;
    cost_output: number | null;
    cost_cache_read: number | null;
    cost_cache_creation: number | null;
    cost_total: number | null;
    has_unpriced: number | null;
  };

  const perModel = db
    .prepare(
      `SELECT model,
              SUM(requests) as requests,
              SUM(input_tokens) as input_tokens,
              SUM(output_tokens) as output_tokens,
              SUM(cache_read_tokens) as cache_read_tokens,
              SUM(cache_creation_tokens) as cache_creation_tokens,
              SUM(cost_total) as cost_total
       FROM daily_usage
       WHERE date LIKE $prefix
       GROUP BY model
       ORDER BY cost_total DESC`,
    )
    .all({ $prefix: monthPrefix }) as Array<{
    model: string;
    requests: number;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cache_creation_tokens: number;
    cost_total: number;
  }>;

  return {
    year,
    month,
    requests: totals.requests ?? 0,
    input_tokens: totals.input_tokens ?? 0,
    output_tokens: totals.output_tokens ?? 0,
    cache_read_tokens: totals.cache_read_tokens ?? 0,
    cache_creation_tokens: totals.cache_creation_tokens ?? 0,
    thinking_tokens: totals.thinking_tokens ?? 0,
    cost_input: totals.cost_input ?? 0,
    cost_output: totals.cost_output ?? 0,
    cost_cache_read: totals.cost_cache_read ?? 0,
    cost_cache_creation: totals.cost_cache_creation ?? 0,
    cost_total: totals.cost_total ?? 0,
    has_unpriced: totals.has_unpriced === 1,
    per_model: perModel,
  };
}

/** Get available months (year-month pairs that have data). */
export function getAvailableMonths(db: Database): Array<{ year: number; month: number }> {
  const rows = db
    .prepare("SELECT DISTINCT substr(date, 1, 7) as ym FROM daily_usage ORDER BY ym DESC")
    .all() as Array<{ ym: string }>;
  return rows.map((r) => ({
    year: Number(r.ym.slice(0, 4)),
    month: Number(r.ym.slice(5, 7)),
  }));
}

/** Get current pricing table. */
export function getPricingTable(db: Database): ModelPricingRow[] {
  return db
    .prepare(
      `SELECT model_id, input_per_mtoken, output_per_mtoken, cache_read_per_mtoken,
              pricing_known, updated_at
       FROM model_pricing
       ORDER BY model_id ASC`,
    )
    .all() as ModelPricingRow[];
}
