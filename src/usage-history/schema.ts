// Schema for the usage_history module — usage_samples (ticket 01) +
// usage_events (ticket 02: composite tuple transitions).
// Owned by the usage-history module (SRP); the capture store (db.ts) does not
// know about these tables.

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

// usage_events — one row per composite tuple transition (priority or service_mode).
// Per decision 04 + 05: carries full ambient context at the moment of transition
// and previous_event_id linking to the open onset/morph it closes (for resolved/morph).
export const USAGE_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  onset_at INTEGER NOT NULL,
  transition TEXT NOT NULL,
  tuple_kind TEXT NOT NULL,
  previous_event_id INTEGER,
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
  cache_hit_rate REAL,
  window_started_at INTEGER,
  window_resets_at INTEGER,
  window_remaining_minutes INTEGER,
  priority_low INTEGER NOT NULL,
  boxed_until INTEGER,
  boxed_reason TEXT,
  units_demoted INTEGER NOT NULL,
  demoted_until INTEGER,
  service_mode_current TEXT NOT NULL,
  service_mode_resets_at INTEGER,
  FOREIGN KEY (previous_event_id) REFERENCES usage_events(id)
);

CREATE INDEX IF NOT EXISTS idx_usage_events_onset_at
  ON usage_events(onset_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_tuple_kind
  ON usage_events(tuple_kind);
`;

/** Run usage_history schema migrations. Idempotent. */
export function migrateUsageHistorySchema(db: Database): void {
  db.exec(USAGE_SAMPLES_DDL);
  db.exec(USAGE_EVENTS_DDL);
}
