# Incident attribution anchored at first non-200 write site

umans-gate anchors incident attribution at the **first** non-200 write
site and never changes it. When a capture transitions through multiple
non-200 states (for example, a TTFT watchdog fires, retry times out,
and the proxy serves a final 504), the incident row's `responsible_party`
and `incident_type` come from the first failure. The
`ON CONFLICT(capture_id) DO UPDATE` clause updates only mutable columns
(`served_status`, `reason`, `finished_at`, `upstream_status`).

Re-deriving attribution on each update would make the incident's identity
depend on write ordering and timing, producing ambiguous attribution
when two non-200 write sites race (for example, an `id_rewrite` incident
that later gets overwritten by `upstream_error` from `doneRes()`).
Anchoring guarantees that the root-cause classification ("what first
caused this capture to become non-200") is stable, while the mutable
columns reflect the final observed state.

The `ON CONFLICT` clause explicitly omits `responsible_party` and
`incident_type` from the `SET` list for this reason, even though SQLite
would accept updating them.
