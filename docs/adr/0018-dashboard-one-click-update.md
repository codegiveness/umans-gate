# Dashboard one-click update with service-manager guard

**Status**: accepted

umans-gate's dashboard can trigger a self-update to the latest published
version via `POST /dashboard/api/update`. The proxy gates this on two
conditions: it must run as a managed service (`isServiceInstalled()`),
and `DASHBOARD_TOKEN` must be set. Without a service manager, the
update would kill the process with nothing to restart it; without the
token, anyone on localhost could trigger a binary replacement.

The update flow does a pre-flight (re-confirms an update exists and
returns `targetVersion` immediately), then asynchronously stops the
service, runs `performUpdate()` (npm global install or binary
replacement), and restarts the service. The client enters an "updating"
state with `/health` polling and auto-reconnects when the server
returns. If `/health` does not respond within 120s, the client shows a
"check `umans-gate service logs`" message.

Version availability is checked once on startup (npm-primary,
GitHub-fallback, reusing `fetchLatestVersion()` from `updater.ts`) and
on-demand via `POST /dashboard/api/version/check`. No interval timer —
the proxy is a dev tool, not a 24/7 service that needs to know about
updates within minutes.

Release notes (GitHub Release body) are fetched only when an update is
detected, not on every check.

## Considered options

- **No one-click update (CLI-only):** safer, but the user explicitly
  asked about one-click and it is a reasonable convenience when a
  service manager is already handling restarts.
- **One-click without service-manager guard:** rejected because
  `performUpdate()` replaces the running executable; without a
  service manager, the process dies and stays down.
- **One-click without `DASHBOARD_TOKEN` guard:** rejected because the
  dashboard is optionally secured; allowing unauthenticated binary
  replacement on localhost is an unacceptable security surface.

## Consequences

- The dashboard gains three new endpoints: `GET /dashboard/api/version`,
  `POST /dashboard/api/version/check`, `POST /dashboard/api/update`.
- The Config tab gains a version/update section with a confirmation
  dialog.
- The header gains a minimal update-availability indicator (dot only,
  no version text).
- The `updater.ts` module's `fetchLatestVersion()` is reused
  server-side; no new external-fetch logic is introduced.
- When prerequisites are not met, the update UI degrades gracefully to
  instructions for running `umans-gate update` in a terminal.
