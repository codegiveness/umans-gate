// SQL DDL: schema + view + per-model ring-buffer retention.
//
// These DDL constants define the SQL schema for capturing usage metrics.
// They are imported by db.ts (for schema migration) and by tests.

/**
 * SQL DDL to add token-usage columns to the captures table.
 * Run after the existing CREATE TABLE (uses ALTER TABLE for migration safety).
 */
export const USAGE_COLUMNS_DDL = `
-- Token usage columns (added to captures table)
ALTER TABLE captures ADD COLUMN provider TEXT;           -- 'anthropic' | 'openai'
ALTER TABLE captures ADD COLUMN model TEXT;              -- e.g. 'claude-sonnet-4-5', 'gpt-4o'
ALTER TABLE captures ADD COLUMN streaming INTEGER DEFAULT 0;
ALTER TABLE captures ADD COLUMN input_tokens INTEGER;
ALTER TABLE captures ADD COLUMN output_tokens INTEGER;
ALTER TABLE captures ADD COLUMN cache_creation_tokens INTEGER;
ALTER TABLE captures ADD COLUMN cache_read_tokens INTEGER;
ALTER TABLE captures ADD COLUMN total_input_tokens INTEGER;
ALTER TABLE captures ADD COLUMN total_output_tokens INTEGER;
ALTER TABLE captures ADD COLUMN thinking_tokens INTEGER;
ALTER TABLE captures ADD COLUMN ttft_ms REAL;
ALTER TABLE captures ADD COLUMN tps REAL;
ALTER TABLE captures ADD COLUMN usage_missing INTEGER DEFAULT 0;
ALTER TABLE captures ADD COLUMN metrics_extracted_at INTEGER;
` as const;

/**
 * SQL view: latest N requests per model with all metrics.
 * Replace :N with the desired window size (default 100).
 *
 * Uses ROW_NUMBER() window function (SQLite 3.25+).
 */
export const LATEST_N_PER_MODEL_VIEW = `
CREATE VIEW IF NOT EXISTS v_latest_requests_per_model AS
WITH ranked AS (
  SELECT
    c.*,
    ROW_NUMBER() OVER (PARTITION BY c.model ORDER BY c.started_at DESC) AS rn
  FROM captures c
  WHERE c.model IS NOT NULL
    AND c.state = 'done'
)
SELECT * FROM ranked WHERE rn <= 100;
` as const;

/**
 * SQL view: per-model percentile summary.
 * Uses the latest-N view as input.
 *
 * NOTE: SQLite does not have built-in percentile functions.
 * This view uses the nearest-rank approximation via subqueries.
 * For exact percentiles, load into the app layer and use computePercentileStats().
 */
export const MODEL_PERCENTILE_VIEW = `
CREATE VIEW IF NOT EXISTS v_model_percentiles AS
WITH base AS (
  SELECT model, provider,
    ttft_ms, tps, duration_ms,
    input_tokens, output_tokens,
    cache_creation_tokens, cache_read_tokens,
    total_input_tokens, total_output_tokens
  FROM v_latest_requests_per_model
  WHERE usage_missing = 0
),
ranked AS (
  SELECT model, provider,
    ttft_ms, tps, duration_ms,
    input_tokens, output_tokens,
    cache_creation_tokens, cache_read_tokens,
    total_input_tokens, total_output_tokens,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY ttft_ms) AS ttft_rn,
    COUNT(ttft_ms) OVER (PARTITION BY model) AS ttft_cnt,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY tps) AS tps_rn,
    COUNT(tps) OVER (PARTITION BY model) AS tps_cnt
  FROM base
)
SELECT
  model,
  provider,
  COUNT(*) AS request_count,
  -- p50 (median): nearest-rank = ceil(0.50 * count)
  MAX(CASE WHEN ttft_rn = CAST(CEIL(0.50 * ttft_cnt) AS INT) THEN ttft_ms END) AS ttft_p50,
  MAX(CASE WHEN tps_rn  = CAST(CEIL(0.50 * tps_cnt)  AS INT) THEN tps  END) AS tps_p50,
  AVG(ttft_ms) AS ttft_mean,
  AVG(tps)     AS tps_mean,
  MIN(ttft_ms) AS ttft_min,
  MAX(ttft_ms) AS ttft_max,
  MIN(tps)     AS tps_min,
  MAX(tps)     AS tps_max,
  AVG(input_tokens)         AS input_mean,
  AVG(output_tokens)         AS output_mean,
  AVG(cache_creation_tokens) AS cache_create_mean,
  AVG(cache_read_tokens)     AS cache_read_mean,
  AVG(total_input_tokens)    AS total_input_mean,
  AVG(total_output_tokens)   AS total_output_mean
FROM ranked
GROUP BY model, provider;
` as const;

/**
 * SQL: per-model ring-buffer retention.
 * Deletes oldest captures per model when count exceeds max_per_model.
 *
 * This is the per-model equivalent of the existing global ring buffer in db.ts
 * (which uses maxCaptures to limit total rows). This DDL enforces a per-model cap.
 *
 * Usage: run after each capture insert. Replace :MAX_PER_MODEL with the limit.
 */
export const PER_MODEL_RETENTION_SQL = `
DELETE FROM captures
WHERE model IS NOT NULL
  AND id IN (
    SELECT id FROM (
      SELECT id,
        ROW_NUMBER() OVER (PARTITION BY model ORDER BY started_at DESC) AS rn,
        COUNT(*) OVER (PARTITION BY model) AS cnt
      FROM captures
      WHERE model IS NOT NULL
    ) WHERE rn > :MAX_PER_MODEL
  );
` as const;

/**
 * SQL: optimized per-model performance summary for the dashboard.
 *
 * Computes p10/p50/p95 for TTFT and TPS, SUM of input/output/cached tokens,
 * and cached% in a single SQL query — no JS post-processing needed.
 *
 * Uses the nearest-rank method (SQLite has no PERCENTILE_CONT).
 * Operates on the latest N requests per model (via v_latest_requests_per_model).
 *
 * Replaces the old approach of loading raw rows into JS and computing
 * percentiles with computePercentileStats() — which over-fetched
 * (latestN * 20 rows) and did all math in the app layer.
 */
export const PERFORMANCE_STATS_SQL = `
WITH latest_per_model AS (
  SELECT model, provider, streaming,
    ttft_ms, tps, duration_ms,
    input_tokens, output_tokens,
    cache_creation_tokens, cache_read_tokens,
    total_input_tokens, total_output_tokens,
    usage_missing,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY started_at DESC) AS rn
  FROM captures
  WHERE model IS NOT NULL AND state = 'done'
),
base AS (
  SELECT model, provider, streaming,
    ttft_ms, tps,
    total_input_tokens, total_output_tokens,
    cache_read_tokens
  FROM latest_per_model
  WHERE rn <= 100 AND usage_missing = 0
),
ranked AS (
  SELECT model, provider, streaming,
    ttft_ms, tps,
    total_input_tokens, total_output_tokens,
    cache_read_tokens,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY ttft_ms) AS ttft_rn,
    COUNT(ttft_ms)      OVER (PARTITION BY model)            AS ttft_n,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY tps)     AS tps_rn,
    COUNT(tps)           OVER (PARTITION BY model)            AS tps_n
  FROM base
)
SELECT
  model,
  provider,
  COUNT(*) AS request_count,
  SUM(CASE WHEN streaming = 1 THEN 1 ELSE 0 END) AS streaming_count,
  SUM(total_input_tokens)  AS total_input_tokens,
  SUM(total_output_tokens) AS total_output_tokens,
  SUM(cache_read_tokens)   AS total_cache_read_tokens,
  CASE
    WHEN SUM(total_input_tokens) > 0
    THEN CAST(SUM(cache_read_tokens) AS REAL) / SUM(total_input_tokens) * 100.0
    ELSE 0
  END AS cached_pct,
  MAX(CASE WHEN ttft_rn = CAST(CEIL(0.10 * ttft_n) AS INT) THEN ttft_ms END) AS ttft_p10,
  MAX(CASE WHEN ttft_rn = CAST(CEIL(0.50 * ttft_n) AS INT) THEN ttft_ms END) AS ttft_p50,
  MAX(CASE WHEN ttft_rn = CAST(CEIL(0.95 * ttft_n) AS INT) THEN ttft_ms END) AS ttft_p95,
  MAX(CASE WHEN tps_rn  = CAST(CEIL(0.10 * tps_n)  AS INT) THEN tps  END) AS tps_p10,
  MAX(CASE WHEN tps_rn  = CAST(CEIL(0.50 * tps_n)  AS INT) THEN tps  END) AS tps_p50,
  MAX(CASE WHEN tps_rn  = CAST(CEIL(0.95 * tps_n)  AS INT) THEN tps  END) AS tps_p95,
  AVG(ttft_ms) AS ttft_mean,
  AVG(tps)     AS tps_mean
FROM ranked
GROUP BY model, provider
ORDER BY request_count DESC;
` as const;

/**
 * SQL: full dashboard query — per-model p10/p50/p95 for all numeric metrics.
 *
 * Because SQLite lacks percentile_cont(), this uses the nearest-rank method
 * with 3 CTEs (one per percentile). For production use, consider:
 *   1. Loading the latest-N view into the app layer and using computePercentileStats()
 *   2. Or defining a custom SQLite extension function (e.g., percentile() via C extension)
 */
export const DASHBOARD_QUERY_SQL = `
WITH base AS (
  SELECT model, provider, streaming,
    ttft_ms, tps, duration_ms,
    input_tokens, output_tokens,
    cache_creation_tokens, cache_read_tokens,
    total_input_tokens, total_output_tokens
  FROM v_latest_requests_per_model
  WHERE usage_missing = 0
),
ranked AS (
  SELECT model, provider,
    ttft_ms, tps,
    input_tokens, output_tokens,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY ttft_ms)       AS ttft_rn,
    COUNT(ttft_ms)      OVER (PARTITION BY model)                   AS ttft_n,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY tps)            AS tps_rn,
    COUNT(tps)           OVER (PARTITION BY model)                   AS tps_n,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY input_tokens)   AS input_rn,
    COUNT(input_tokens)  OVER (PARTITION BY model)                   AS input_n,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY output_tokens)  AS output_rn,
    COUNT(output_tokens) OVER (PARTITION BY model)                   AS output_n
  FROM base
)
SELECT
  model,
  provider,
  MAX(CASE WHEN ttft_rn  = CAST(CEIL(0.10 * ttft_n)  AS INT) THEN ttft_ms END) AS ttft_p10,
  MAX(CASE WHEN ttft_rn  = CAST(CEIL(0.50 * ttft_n)  AS INT) THEN ttft_ms END) AS ttft_p50,
  MAX(CASE WHEN ttft_rn  = CAST(CEIL(0.95 * ttft_n)  AS INT) THEN ttft_ms END) AS ttft_p95,
  MAX(CASE WHEN tps_rn   = CAST(CEIL(0.10 * tps_n)   AS INT) THEN tps END)     AS tps_p10,
  MAX(CASE WHEN tps_rn   = CAST(CEIL(0.50 * tps_n)   AS INT) THEN tps END)     AS tps_p50,
  MAX(CASE WHEN tps_rn   = CAST(CEIL(0.95 * tps_n)   AS INT) THEN tps END)     AS tps_p95,
  MAX(CASE WHEN input_rn  = CAST(CEIL(0.10 * input_n) AS INT) THEN input_tokens END)  AS input_p10,
  MAX(CASE WHEN input_rn  = CAST(CEIL(0.50 * input_n) AS INT) THEN input_tokens END)  AS input_p50,
  MAX(CASE WHEN input_rn  = CAST(CEIL(0.95 * input_n) AS INT) THEN input_tokens END)  AS input_p95,
  MAX(CASE WHEN output_rn = CAST(CEIL(0.10 * output_n) AS INT) THEN output_tokens END) AS output_p10,
  MAX(CASE WHEN output_rn = CAST(CEIL(0.50 * output_n) AS INT) THEN output_tokens END) AS output_p50,
  MAX(CASE WHEN output_rn = CAST(CEIL(0.95 * output_n) AS INT) THEN output_tokens END) AS output_p95,
  AVG(ttft_ms)       AS ttft_mean,
  AVG(tps)           AS tps_mean,
  AVG(input_tokens)  AS input_mean,
  AVG(output_tokens) AS output_mean,
  COUNT(*) AS request_count
FROM ranked
GROUP BY model, provider
ORDER BY request_count DESC;
` as const;
