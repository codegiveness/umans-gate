# Config tab uses sub-tabs for category navigation

## Status

Accepted. Governs the rendering of `GROUPS` in `dashboard/src/components/config-tab.tsx`.

## Context

The Config tab previously rendered all three `GroupDef` entries (General,
Experimental, Advanced) as a single flat scroll inside one `ScrollArea`
(`config-tab.tsx:288`). With 60+ fields across 14 sections, the flat
scroll made category detection difficult — users had to scroll past
General to reach Experimental, and Advanced (queue/vision-tuning/storage)
was buried at the bottom.

The top-level tab strip (`App.tsx:143`) already holds 7 tabs (Captures,
Vision, Performance, Economics, Usage, Models, Config) and overflows on
mobile. Adding an 8th top-level "Experimental" tab would worsen mobile
overflow and fragment the single source of config truth.

The three `GroupDef` entries already exist in `config-sections.ts:549`
as a structured array — the data model was ready for navigation, only the
rendering was flat.

## Decision

**The Config tab renders a secondary tab strip — one pane per `GroupDef`
(General, Experimental, Advanced) — instead of a flat scroll.**

1. **Sub-tabs, not a new top-level tab.** Config stays one top-level tab.
   Categories become navigation inside it. No 8th top-level tab.
2. **Default to General on every open.** No `localStorage` persistence.
   Matches the existing top-level pattern (`activeTab` starts at
   "captures", `App.tsx:91`) — no implicit state.
3. **"Experimental features active" banner stays global** — rendered
   above the sub-tab strip, visible on all three panes. The banner is a
   state warning (proxy behavior may differ), not a section warning.
   ADR-0016 §3 says the humility claim covers *proxy behavior*, not
   section behavior — so the reminder belongs wherever the user is.
4. **Sub-tab strip is its own sticky row** below the Save/Reset header
   and banners, above the `ScrollArea`. Header = actions; sub-tab strip
   = navigation. Different layers, not crowded together.
5. **VersionSection renders only on the General pane.** It's version /
   one-click-update detail — pairs with Server/Credentials (General
   fields). Persisting it on Experimental/Advanced eats vertical space
   where it's irrelevant. The global `UpdateIndicator`
   (`App.tsx:182`) already surfaces "update available" app-wide.
6. **"Restart required" footer note renders on every pane.** The
   `restartRequired` badge appears on fields across all three panes
   (`port`, `db_path`, `warmer_enabled`, `usage_refresh_ms`,
   `models_refresh_ms`, `umans_api_key`) — the legend belongs wherever
   the badges can appear.

## Consequences

- `ConfigTab` adds sub-tab state (`useState<keyof GroupDef>`) and renders
  only the active group's `GroupBlock` instead of mapping all of
  `groupsWithOverrides`. The `VersionSection` lazy import stays gated to
  the General pane.
- The sub-tab strip adds ~40px of fixed vertical space inside Config.
  Acceptable — Config is not a dense data view like Captures.
- Future config sections are added to `config-sections.ts` and
  automatically appear under their group's sub-tab. No rendering change
  needed — the sub-tab list derives from `GROUPS`.
- Reverting to flat scroll is a one-component revert (remove sub-tab
  state, restore `groupsWithOverrides.map`). Low cost — but reverting
  loses the discoverability win, so the change is expected to be stable.
