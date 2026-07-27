# Configurable performance sample count

## Context

umans-gate computes performance percentiles from a fixed 100-row sample
window in `PERFORMANCE_STATS_SQL` (`src/usage/ddl.ts`), which ignores half
the default 200-capture ring buffer. The `v_latest_requests_per_model`
view was also hardcoded to 100, but it was dead code in production — only
`PERFORMANCE_STATS_SQL` feeds `getPerformanceStats()`, and only tests
queried the view directly.

## Decision

The proxy makes the performance sample count a **standalone,
hot-reloadable config field** (`performance_sample_count`, default 200),
and parameterizes the SQL query with a bound `$limit` parameter.

### Config field

- **Name**: `performance_sample_count` / `PERFORMANCE_SAMPLE_COUNT`
- **Default**: 200 (same as `MAX_CAPTURES` default, but decoupled)
- **Hot-reloadable**: yes
- **Dashboard Config tab**: exposed alongside other hot-reloadable fields

The field is decoupled from `maxCaptures` because they serve different
purposes: `maxCaptures` is retention (how many captures to keep), while
`performance_sample_count` is statistical window (how many samples to
compute percentiles over). A user with `MAX_CAPTURES=500` may want a
200-sample performance window for faster SQL and stable percentiles.

### SQL parameterization

`PERFORMANCE_STATS_SQL` changes from `WHERE rn <= 100` to
`WHERE rn <= $limit`. The prepared statement is compiled once at DB
init; the `$limit` value is bound fresh on each `.all()` call from
`CaptureDB.performanceSampleLimit`.

### View removal

`LATEST_N_PER_MODEL_VIEW` (the `v_latest_requests_per_model` view) is
deleted entirely. It was dead code in production — `PERFORMANCE_STATS_SQL`
is a standalone query with its own `ROW_NUMBER()` window that does not
reference the view. The stale comment on `db.ts` ("Uses the
v_latest_requests_per_model view") is corrected. Tests that queried the
view directly are updated to test through `getPerformanceStats()`.

### Hot-reload mechanism

Same pattern as `compression_enabled`: `CaptureDB` gets a mutable
`performanceSampleLimit` field, read at query time. On hot-reload,
`reloadConfig()` sets `db.performanceSampleLimit =
config.performanceSampleCount`. No prepared statement recompilation, no
view recreation — the bound parameter changes per-call with zero
recompilation cost.

## Alternatives considered

- **Hardcode 200** — matches the default `MAX_CAPTURES` but doesn't help
  users who change either value. Rejected because the field is trivial to
  make configurable and the current hardcoding is the root cause of the
  wasted-data complaint.

- **Always track `maxCaptures`** — no new config field; the performance
  window always equals the ring buffer size. Rejected because the two
  serve different purposes: a user with `MAX_CAPTURES=50` would get
  unstable percentiles from only 50 samples, while a user with
  `MAX_CAPTURES=500` might want faster SQL with a 200-sample window.

- **Recreate the view on config change** — DROP VIEW + CREATE VIEW with
  the new limit on hot-reload. Rejected because the view is dead code;
  removing it is simpler than keeping it alive.

## Consequences

- `ProxyConfig` gains `performanceSampleCount: number` (default 200).
- `RawConfig` gains `performance_sample_count?: number`.
- `config/loader.ts` parses the new field with `PERFORMANCE_SAMPLE_COUNT`
  env var override.
- `CaptureDB` gains `performanceSampleLimit: number` (mutable, like
  `compressionEnabled`).
- `getPerformanceStats()` binds `$limit` from `this.performanceSampleLimit`.
- `PERFORMANCE_STATS_SQL` uses `$limit` instead of literal `100`.
- `LATEST_N_PER_MODEL_VIEW` DDL is deleted.
- `migrateCaptureSchema()` no longer creates the view (migration-safe
  because `CREATE VIEW IF NOT EXISTS` was already idempotent).
- Tests referencing `v_latest_requests_per_model` are updated.
- Dashboard Config tab gains the new field.
