# Mid-stream client abort does not produce a client_aborted incident

When a client disconnects *during* streaming (after the upstream response
headers arrived), the capture records the upstream's final status with
`status_source: "upstream"` — not 499. No `client_aborted` incident fires
for this case, even though `req.signal.aborted` is true.

`client_aborted` incidents are reserved for the pre-stream paths where
the client disconnects before any upstream response is received: the
`acquirePermit` GateError catch (499 aborted-while-enqueued), the TTFT
fetch-error 499, and the rewrite-escalation 499. In those cases, the
client's disconnect is the *cause* of the non-200 — no upstream response
was ever produced.

In the mid-stream case, the upstream already returned a status. If it was
200 and the client gave up, that's client impatience, not a proxy
failure — recording it would flood the incidents table with
non-failures. If it was 500 and the client gave up, the 500 is the real
story and an `upstream_error` incident fires; the client abort is a
secondary detail.

This decision can be reversed cheaply (add a `recordIncident` call in
the `onAbort` handler) but is intentionally conservative to keep the
incidents table focused on actionable failures.
