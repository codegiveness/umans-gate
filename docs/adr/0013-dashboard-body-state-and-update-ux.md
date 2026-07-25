# Dashboard body-state distinction and update-button UX

**Status**: proposed

## Context

Three independent dashboard UX problems surfaced together:

1. **BodyRenderer ambiguity** — `BodyRenderer` renders "body corrupted or
   unavailable" for every `response_body === null` case. But null means
   different things: an in-flight capture (state `enqueued`/`streaming`/
   `cooling_down`) legitimately has no body yet, while a `done` capture
   with null body indicates either no body was stored or decompression
   failed on a stored body. The conflation makes the inspector misleading
   for the most common case (watching a live capture).

2. **UpdateButton greyed out** — the one-click update button is disabled
   when `canUpdate=false` (`no_token` or `no_service`). The tooltip
   explains the reason, but a disabled button is easy to click past
   without reading the tooltip, leaving the user confused about why
   "Update" doesn't work.

3. **What's New not using shadcn** — the collapsible release-notes section
   in `version-section.tsx` uses a native `<button>` and a
   `<pre className="overflow-y-auto">` instead of shadcn `Button` and
   `ScrollArea`, inconsistent with the rest of the dashboard.

A broader scan also found non-shadcn scroll containers in
`capture-detail.tsx` (two `<main overflow-y-auto>` fallback states) and
`usage-heatmap.tsx` (`<div overflow-x-auto>`).

## Decision

### 1. BodyRenderer — distinguish in-flight from done

Pass the capture `state` into `BodyRenderer`. Render three cases:

- **In-flight** (`enqueued` | `streaming` | `cooling_down`): spinner +
  "Response still streaming…" — neutral, informational.
- **Done + null body**: "Response body not captured" — muted, not
  destructive red. Covers both "no body stored" and "decompression
  failed" without distinguishing them. The destructive red treatment is
  reserved for actual errors the user can act on; a missing body is a
  data gap, not a corruption alarm.
- **Empty string** (`""`): existing "empty body" treatment, unchanged.

We deliberately do **not** add a server-side signal to distinguish
decompression failure from "no body stored". The db layer logs the
decompression failure server-side (`CaptureDB.log.warn`); surfacing it
in the dashboard would require a new field on `CaptureDetail`, and the
user's action is the same in both cases (nothing — the body is gone).
The cost of a backend change outweighs the value of distinguishing two
non-actionable null reasons.

### 2. UpdateButton — always enabled, dialog explains blocker

The Update button is always enabled. When `canUpdate=false`, clicking
it opens an `AlertDialog` (not the update-confirm dialog) explaining
the specific blocker:

- `no_token`: "One-click update requires `DASHBOARD_TOKEN` to be set.
  Configure it in the Config tab and restart the server."
- `no_service`: "One-click update requires the proxy to run as a managed
  service. Run `umans-gate service install` in your terminal."

When `canUpdate=true`, the existing confirm → update flow is unchanged.

This replaces the disabled-button + tooltip pattern. A disabled button
hides the reason behind a hover; an always-enabled button with a dialog
makes the blocker immediately visible on click.

### 3. What's New — shadcn components

- Native `<button>` → `Button variant="ghost" size="sm"`.
- `<pre className="overflow-y-auto">` → `ScrollArea` wrapping a `<pre>`
  (the `<pre>` keeps `whitespace-pre-wrap` for text formatting; the
  `ScrollArea` owns the scroll).

### 4. Other non-shadcn scroll containers

- `capture-detail.tsx` lines 117, 136 — two `<main overflow-y-auto>`
  fallback states (error and empty-select) → `ScrollArea`. The main
  content area (line 277) already uses `ScrollArea`; these fallback
  states should match.
- `usage-heatmap.tsx` line 197 — `<div overflow-x-auto>` → `ScrollArea`
  with `orientation="horizontal"` if supported, else vertical `ScrollArea`
  wrapping a horizontally-scrolling inner div.
- `body-renderer.tsx` and `sse-viewer` `<pre>` tags **without** overflow
  are left as-is. They are content display elements inside a parent
  `ScrollArea`, not scroll containers themselves.

## Considered Options

### BodyRenderer

- **Server signal (rejected)** — add a `body_status` field to
  `CaptureDetail` distinguishing `in_flight` / `no_body` /
  `decompression_failed`. Most accurate, but requires a backend schema
  change, a new db query path, and the user cannot act on the
  distinction. Rejected as over-engineering for non-actionable states.
- **Better messages only (rejected)** — change the text without passing
  `state`. Cannot distinguish in-flight from done, so the most common
  case (watching a live capture) still shows a confusing message.

### UpdateButton

- **Disabled + visible badge (rejected)** — keep the button disabled but
  add an amber badge ("Token required" / "Service required"). Less
  disruptive than a dialog, but the badge adds visual noise to the
  already-busy version card and still requires the user to read small
  text to understand the fix.
- **Actionable fix guidance (rejected)** — auto-scroll to
  `DASHBOARD_TOKEN` field or show install command with copy button.
  Nice UX, but scope-creep: the token field is in the same Config tab,
  and the install command is a one-liner the user can type. A clear
  dialog message is sufficient.

## Consequences

- `BodyRenderer` gains a `state` prop. All call sites
  (`capture-detail.tsx` lines 280, 283) must pass it. The request body
  is always available immediately, so `state` only affects the response
  body rendering — request body rendering keeps the existing null/empty
  logic.
- The UpdateButton dialog adds a new `AlertDialog` state to
  `VersionCard`. The existing update-confirm `AlertDialog` is reused
  only when `canUpdate=true`.
- `ScrollArea` in the What's New section adds a fixed max-height wrapper.
  The current `max-h-48` (192px) is preserved as the ScrollArea height.
- `capture-detail.tsx` fallback states gain scrollbar styling consistent
  with the main content area.
- No backend changes. No new API fields. No new tests strictly required
  for the shadcn migrations, but the `BodyRenderer` state-prop change
  should have a test verifying in-flight vs done rendering.
