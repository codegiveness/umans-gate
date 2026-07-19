// Schema for the usage_samples table — one row per coalesced /v1/usage poll.
// Owned by the usage-history module (SRP); the capture store (db.ts) does not
// know about this table.

import type { Database } from "bun:sqlite";

export const USAGE_SAMPLES_DDL = `
CREATE TABLE IF NOT EXISTS usage_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fetched_at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  user_id TEXT,
  plan TEXT NOT NULL,
  plan_slug TEXT,
  requests_limit INTEGER,
  requests_hard_cap INTEGER,
  requests_window_seconds INTEGER,
  concurrency_soft_limit INTEGER NOT NULL,
  concurrency_hard_cap INTEGER NOT NULL,
  requests_in_window INTEGER NOT NULL,
  weighted_requests_in_window INTEGER NOT NULL,
  requests_remaining INTEGER,
  weighted_remaining_requests INTEGER,
  concurrent_sessions INTEGER NOT NULL,
  weighted_concurrent_sessions INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  tokens_cached INTEGER NOT NULL,
  window_started_at INTEGER,
  window_resets_at INTEGER,
  window_remaining_minutes INTEGER,
  priority_low INTEGER NOT NULL,
  boxed_until INTEGER,
  boxed_reason TEXT,
  units_demoted INTEGER NOT NULL,
  demoted_until INTEGER,
  service_mode_current TEXT NOT NULL,
  service_mode_resets_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_usage_samples_fetched_at
  ON usage_samples(fetched_at);
`;

/** Run usage_samples schema migration. Idempotent. */
export function migrateUsageHistorySchema(db: Database): void {
  db.exec(USAGE_SAMPLES_DDL);
}
