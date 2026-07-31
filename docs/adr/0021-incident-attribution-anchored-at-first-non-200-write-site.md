# Incident attribution — per-attempt incident rows

umans-gate records one incident row per non-200 event. When a capture
transitions through multiple non-200 states (for example, a TTFT watchdog
fires on attempt 1, retry times out on attempt 2, and the proxy serves a
final 504), each timeout gets its own incident row. The
`incidents.capture_id` column is NOT unique — multiple rows per capture
are allowed and expected for TTFT-retry lifecycles.

Each TTFT-timeout incident row records the attempt number, the threshold
that was exceeded, and the model p50 (when available) in its `reason`
field, so operators can audit every retry attempt individually.

Non-TTFT terminal paths (client abort, upstream error, gate rejection)
still write exactly one incident row per capture at the terminal exit
point, since those paths do not have a retry ladder.

## Superseded: single-incident-per-capture model

Previously (pre this revision), `incidents.capture_id` carried a `UNIQUE`
constraint and `recordIncident` used `ON CONFLICT(capture_id) DO UPDATE`
to collapse all non-200 events for a capture into a single row. That model
prevented per-attempt visibility into TTFT-retry lifecycles. The migration
in `migrateCaptureSchema()` detects legacy DBs with the UNIQUE index and
recreates the table without it, preserving existing rows.

## Mutable columns

Since each incident row is now per-event (not per-capture), there is no
upsert. `recordIncident` performs a plain `INSERT`. The `reason`,
`served_status`, and `upstream_status` columns reflect the state at the
time of the event that created the row.
