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
ALTER TABLE captures ADD COLUMN thinking_block_count INTEGER;
ALTER TABLE captures ADD COLUMN ttft_ms REAL;
ALTER TABLE captures ADD COLUMN tps REAL;
ALTER TABLE captures ADD COLUMN usage_missing INTEGER DEFAULT 0;
ALTER TABLE captures ADD COLUMN metrics_extracted_at INTEGER;
` as const;

/**
 * SQL: optimized per-model performance summary for the dashboard.
 *
 * Computes mean TTFT/TPS and nearest-rank percentiles (p10/p50/p95), plus
 * SUM of input/output/cached tokens and cached% in a single scan over the
 * latest $limit done requests per model. IQR/stddev removed — average is
 * shown as the primary metric.
 *
 * The $limit parameter is bound at query time (default 200) to control the
 * sample window without recompiling the prepared statement.
 */
export const PERFORMANCE_STATS_SQL = `
WITH latest_per_model AS (
  SELECT model, provider, streaming,
    ttft_ms, tps,
    total_input_tokens, total_output_tokens,
    cache_read_tokens, thinking_tokens, thinking_block_count,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY started_at DESC) AS rn
  FROM captures
  WHERE model IS NOT NULL AND state = 'done'
),
base AS (
  SELECT model, provider, streaming,
    ttft_ms, tps,
    total_input_tokens, total_output_tokens,
    cache_read_tokens, thinking_tokens, thinking_block_count
  FROM latest_per_model
  WHERE rn <= $limit
),
ranked AS (
  SELECT
    model, provider, streaming,
    ttft_ms, tps,
    total_input_tokens, total_output_tokens, cache_read_tokens, thinking_tokens, thinking_block_count,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY ttft_ms NULLS LAST) AS ttft_rn,
    COUNT(ttft_ms)     OVER (PARTITION BY model) AS ttft_cnt,
    ROW_NUMBER() OVER (PARTITION BY model ORDER BY tps NULLS LAST) AS tps_rn,
    COUNT(tps) OVER (PARTITION BY model) AS tps_cnt
  FROM base
),
pctiles AS (
  SELECT
    model,
    MAX(CASE WHEN ttft_rn = CAST(CEIL(0.10 * ttft_cnt) AS INT) THEN ttft_ms END) AS ttft_p10,
    MAX(CASE WHEN ttft_rn = CAST(CEIL(0.50 * ttft_cnt) AS INT) THEN ttft_ms END) AS ttft_p50,
    MAX(CASE WHEN ttft_rn = CAST(CEIL(0.95 * ttft_cnt) AS INT) THEN ttft_ms END) AS ttft_p95,
    MAX(CASE WHEN tps_rn  = CAST(CEIL(0.10 * tps_cnt)  AS INT) THEN tps END)     AS tps_p10,
    MAX(CASE WHEN tps_rn  = CAST(CEIL(0.50 * tps_cnt)  AS INT) THEN tps END)     AS tps_p50,
    MAX(CASE WHEN tps_rn  = CAST(CEIL(0.95 * tps_cnt)  AS INT) THEN tps END)     AS tps_p95
  FROM ranked
  GROUP BY model
)
SELECT
  r.model,
  r.provider,
  COUNT(*) AS request_count,
  SUM(CASE WHEN r.streaming = 1 THEN 1 ELSE 0 END) AS streaming_count,
  SUM(r.total_input_tokens)  AS total_input_tokens,
  SUM(r.total_output_tokens) AS total_output_tokens,
  SUM(r.cache_read_tokens)   AS total_cache_read_tokens,
  SUM(r.thinking_tokens)     AS total_thinking_tokens,
  SUM(CASE WHEN r.thinking_block_count > 0 THEN 1 ELSE 0 END) AS requests_with_thinking,
  CASE
    WHEN SUM(r.total_input_tokens) > 0
    THEN CAST(SUM(r.cache_read_tokens) AS REAL) / SUM(r.total_input_tokens) * 100.0
    ELSE 0
  END AS cached_pct,
  AVG(r.ttft_ms) AS ttft_mean,
  MAX(r.ttft_ms) AS ttft_max,
  MAX(p.ttft_p10)      AS ttft_p10,
  MAX(p.ttft_p50)      AS ttft_p50,
  MAX(p.ttft_p95)      AS ttft_p95,
  AVG(r.tps) AS tps_mean,
  MIN(r.tps) AS tps_min,
  MAX(p.tps_p10)       AS tps_p10,
  MAX(p.tps_p50)       AS tps_p50,
  MAX(p.tps_p95)       AS tps_p95
FROM ranked r
LEFT JOIN pctiles p USING (model)
GROUP BY r.model, r.provider
ORDER BY request_count DESC;
` as const;
