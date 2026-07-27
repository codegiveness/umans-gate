# Drop DASHBOARD_TOKEN update guard; push version via WebSocket

**Status**: accepted

Supersedes the `DASHBOARD_TOKEN` update-guard portions of
[ADR-0018](0018-dashboard-one-click-update.md) and
[ADR-0013](0013-dashboard-body-state-and-update-ux.md).

## Context

umans-gate's one-click update gate required both `DASHBOARD_TOKEN` and a
managed service (ADR-0018). The token guard's stated rationale was that
"without the token, anyone on localhost could trigger a binary
replacement." That rationale contradicted the dashboard auth model:
`DASHBOARD_TOKEN` defaults to an empty string in
`src/config/defaults.ts`, and when empty every `/dashboard/api/*` route is
open by design. The default dashboard is unauthenticated, yet the update
endpoint pretended auth was mandatory. A user with the default open
dashboard could click Update and hit a "configure DASHBOARD_TOKEN"
blocker — confusing, not secure.

`DASHBOARD_TOKEN` guards dashboard access, not update authorization.
Only `isServiceInstalled()` determines whether the process restarts
after `performUpdate()` replaces the binary. The token check was
redundant defense-in-depth that became user-hostile in the default
configuration.

A second issue surfaced in the same discussion: the dashboard learned
about version availability only from `GET /dashboard/api/version` on
mount and `POST /dashboard/api/version/check` on manual click. If an
update became available while the dashboard was open, the user had to
reload the browser. The WebSocket layer was underused (ADR-0018 had
explicitly chosen "no interval timer").

## Decision

### 1. Remove the `DASHBOARD_TOKEN` update guard

`POST /dashboard/api/update` no longer checks `ctx.config.dashboardToken`.
The only pre-flight gates are:

1. `isServiceInstalled()` — process restart safety (unchanged).
2. `info.updateAvailable && info.latest` — an update exists (unchanged).

The `token_not_set` error code and its dashboard UI branch are removed.

`refreshVersionCheck()` in `updater.ts` no longer takes a
`dashboardToken` parameter. `canUpdate` is now `true` iff a service
manager is installed. `canUpdateReason` collapses to `null` or
`"no_service"`; `"no_token"` is no longer produced.

### 2. Update button reflects the simpler logic

`version-section.tsx` and `update-indicator.tsx`:

- The `no_token` AlertDialog branch is removed.
- When `canUpdate=false`, the only remaining blocker dialog is
  `no_service` ("run `umans-gate service install`").
- When `canUpdate=true`, the confirm → update flow is unchanged.

### 3. Push version availability over WebSocket

Add a new `WsMessage` variant:

```typescript
| { type: "version"; version: VersionInfo }
```

The server broadcasts this message:

- Once on startup, after the initial `refreshVersionCheck()` completes.
- On every `POST /dashboard/api/version/check` completion, so a manual
  re-check propagates to all connected dashboard clients.

The dashboard's `useVersion()` hook subscribes to the `version` WS
message and updates state in place — no browser reload required to see
a newly-available update. The existing HTTP fallback (`GET
/dashboard/api/version` on mount, `POST /check` on click) remains for
initial load and explicit re-check; the WS push is additive.

No interval timer is added on either side. The proxy still checks once
on startup and on-demand. This keeps ADR-0018's "no interval timer"
stance intact while removing the browser-reload friction.

## Considered options

- **Keep token guard, document the contradiction (rejected):** the
  contradiction is not a documentation problem — it is a design flaw.
  The default open dashboard makes the guard user-hostile, and the
  guard adds no real security beyond what the service-manager check
  already provides.
- **Auto-generate `DASHBOARD_TOKEN` on first run (rejected):** shifts
  the auth model from opt-in to default-on, breaking backward
  compatibility for every existing open-dashboard deployment, and
  forces users to retrieve a generated secret they never asked for.
  The token is a user-supplied shared secret; the proxy cannot pick a
  meaningful one on the user's behalf.
- **Keep token guard only when token is set (rejected):** the user
  asked for this, but it still leaves the default-config user unable
  to one-click update — the exact complaint that surfaced this issue.
  The service-manager guard is sufficient and consistent.
- **Interval timer for version checks (rejected):** ADR-0018 already
  rejected this. The WS push on startup + on-demand covers the
  "dashboard is already open when an update drops" case without
  polling.

## Consequences

- `POST /dashboard/api/update` drops the `token_not_set` error path.
  The `not_service_managed` and `already_up_to_date` paths are
  unchanged.
- `refreshVersionCheck()` signature changes: the `dashboardToken`
  parameter is removed. All callers (`viewer.ts` version/check
  handler) must be updated.
- `VersionInfo.canUpdateReason` type narrows from
  `null | "no_token" | "no_service"` to `null | "no_service"`.
- The dashboard `VersionCard` blocker `AlertDialog` loses its
  `no_token` branch. The `no_service` branch is retained.
- A new `WsMessage` variant `{ type: "version"; version: VersionInfo }`
  is added. `WsBroadcaster.broadcast()` already handles arbitrary
  `WsMessage` shapes — no broadcaster change needed.
- `useVersion()` hook adds a WebSocket subscription. The existing HTTP
  fetch on mount remains (covers cold-start before WS connects).
- Tests:
  - `test/sec-new-1-dashboard-token-auth.test.ts` — any assertion on
    `token_not_set` from the update endpoint must be removed or
    rewritten to expect `not_service_managed` instead.
  - `dashboard/src/__tests__/version-section.test.tsx` — any
    `no_token` dialog assertion must be removed.
  - New test: WS `version` message updates `useVersion` state without
    an HTTP call.
- The README "Secure the dashboard" section is unchanged: setting
  `DASHBOARD_TOKEN` still secures dashboard access, it just no longer
  affects one-click update.
