# Incident writes bypass WriteQueue and go direct to the DB

umans-gate inserts incident rows via direct `db.recordIncident()` calls at
each non-200 write site in `src/proxy.ts`, not through the `WriteQueue`
batched-flush path that capture updates use.

`WriteQueue` exists to batch the hundreds of `queueUpdate` calls that
streaming SSE responses generate, one per chunk-batch. Incident writes
are one-per-failed-capture, all on terminal error paths, and never in a
hot loop. Batching them adds queue depth pressure and flush-timing
indeterminism for zero throughput benefit.

The trade-off is transactional atomicity: a capture row and its incident
row are not written in the same transaction. If the DB errors between
the two writes, the capture exists without an incident. This is acceptable
because incidents are an audit overlay; the capture's `status_source`
and `gate_reason` columns already carry the attribution data. The
incident row is a denormalized, filterable projection. A missing incident
degrades the Incidents tab; a missing capture degrades everything.

This mirrors the existing `recordIdRewriteAudit()` pattern, which also
bypasses `WriteQueue` for the same reasons.
