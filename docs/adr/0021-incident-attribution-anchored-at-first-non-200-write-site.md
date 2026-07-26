# Incident attribution anchored at first non-200 write site

When a capture transitions through multiple non-200 states (e.g. a TTFT
watchdog fires, retry is attempted, retry also times out, final 504 is
served), the incident row's `responsible_party` and `incident_type` are
anchored at the **first** non-200 write site and never change. The
`ON CONFLICT(capture_id) DO UPDATE` clause updates only mutable columns
(`served_status`, `reason`, `finished_at`, `upstream_status`).

The alternative — re-deriving attribution on each update — would make
the incident's identity depend on write ordering and timing, producing
ambiguous attribution when two non-200 write sites race (e.g. an
`id_rewrite` incident that later gets overwritten by `upstream_error`
from `doneRes()`). Anchoring guarantees that the root-cause classification
("what first caused this capture to become non-200") is stable, while
the mutable columns reflect the final observed state.

This is why the `ON CONFLICT` clause explicitly omits `responsible_party`
and `incident_type` from the `SET` list, even though SQLite would accept
updating them.
