# Mid-stream client abort produces a client_aborted incident

**Status:** Supersedes the original conservative stance (see "Reversal"
below). Mid-stream client disconnects now produce a `client_aborted`
incident.

umans-gate creates a `client_aborted` incident when a client disconnects
*during* streaming (after the upstream response headers arrived but before
the stream completes). The capture still records the upstream's final
status with `status_source: "upstream"`, but the incident row carries
`upstream_status` = the upstream's status (typically 200) and
`served_status` = 499 (the client got cut off mid-stream).

The incident is written from the `onAbort` handler in `src/proxy.ts`,
guarded by `req.signal.aborted` so it only fires for client-initiated
disconnects — not for `upstreamSignal` timeouts (which are a separate
failure mode handled by the TTFT / upstream-error paths). The handler is
registered with `{ once: true }` and the `flushed` flag in `flushCapture`
prevents double-firing.

`client_aborted` incidents also fire on pre-stream paths where the client
disconnects before any upstream response is received: the
`acquirePermit` GateError catch (499 aborted-while-enqueued), the TTFT
fetch-error 499, and the rewrite-escalation 499.

## Reversal

The original ADR-0023 took a conservative stance: mid-stream client aborts
were *not* logged as incidents, on the grounds that a 200 upstream status
meant client impatience (not a proxy failure) and a 500 upstream status
was already covered by `upstream_error`. That decision explicitly noted it
"can be reversed cheaply (add a `recordIncident` call in the `onAbort`
handler)".

Operators reported that mid-stream client disconnects were invisible in
the dashboard — there was no signal that a client gave up on a streaming
response. The reversal adds that signal while preserving the upstream's
status as `upstream_status` on the incident row, so operators can still
distinguish "client gave up on a 200" from "client gave up on a 500 that
also produced an `upstream_error` incident".
