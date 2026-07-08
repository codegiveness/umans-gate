---
target: dashboard/src/App.tsx
total_score: 28
p0_count: 0
p1_count: 3
timestamp: 2026-07-07T01-44-37Z
slug: dashboard-src-app-tsx
---
Method: dual-agent (A: bg_f3f9c314 · B: bg_db31ae27)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | No staleness indicator on list during WS outage; config errors are toast-only |
| 2 | Match System / Real World | 3 | "boxed" / "deprioritized" / "tier" jargon has no inline glossary; tooltips exist only for breaker |
| 3 | User Control and Freedom | 3 | Clear gated by confirm dialog; Reset Draft exists; no undo on completed clear |
| 4 | Consistency and Standards | 3 | 5 raw Tailwind/hex colors bypass committed HSL tokens; side-stripe selection vs bg-accent elsewhere |
| 5 | Error Prevention | 3 | Clear confirm dialog ✓; Save disabled when not dirty ✓; no inline config validation; no unsaved-changes guard on tab switch |
| 6 | Recognition Rather Than Recall | 3 | Icons+labels on buttons; title attrs on row metrics; config errors don't persist inline |
| 7 | Flexibility and Efficiency | 3 | Keyboard listbox nav ✓; lazy loading ✓; no Cmd+1/2/3/4 tab shortcuts; no command palette/filter/search |
| 8 | Aesthetic and Minimalist Design | 3 | Density appropriate; gate-status row over-dense (7+ signals); detail header wraps unpredictably; side-stripe decorative |
| 9 | Error Recovery | 2 | Retry on ErrorState ✓; config errors toast-only with no field mapping; WS-down no recovery affordance; copy-fail reverts in 1.2s |
| 10 | Help and Documentation | 2 | Tooltips on breaker; empty states teach; no glossary for gate-status jargon; no help affordance |
| **Total** | | **28/40** | **Solid (25–32)** |

## Anti-Patterns Verdict

**LLM assessment:** A trained eye would NOT immediately call this "AI-made." The shadcn/ui new-york + slate base is the correct, non-sloppy choice. Typography is one sans family at fixed 13px (product-register correct). No gradient text, no glassmorphism-as-default, no hero-metric template, no identical card grids, no eyebrow-on-every-section, no 01/02/03 scaffolding. The IA is recognizable (Linear/Vercel/Stripe-adjacent) rather than invented.

However, four spots trip the "AI" detector:
1. `gate-status.tsx:46` — `text-[#ffcb82]` raw hex for queued-count color, bypassing the committed `--warning` token that exists for exactly this purpose.
2. `gate-status.tsx:75` — `bg-yellow-500` hardcoded Tailwind palette color in the capacity bar.
3. `capture-row-item.tsx:46` — `border-l-[3px] border-l-primary` — a 3px left side-stripe, the #1 item on the absolute-bans list.
4. `config-tab.tsx:154,176` + `config-fields.tsx:44` — `text-amber-500` (3 occurrences); `ws-status-badge.tsx:53` — `text-green-500`. Raw Tailwind colors where `text-warning-foreground` / `text-success-foreground` exist and are used elsewhere.

None catastrophic; collectively they read as "90% disciplined, with a handful of escape hatches." The slop is concentrated in color discipline, not composition.

**Deterministic scan:** The automated detector (`detect.mjs`) returned clean — `[]` with exit code 0 — across all six scanned paths (App.tsx, components/, components/ui/, components/layout/, index.css). Zero findings, zero rule violations. Note: the detector did NOT catch the side-stripe border, hardcoded colors, or missing reduced-motion that the qualitative review surfaced. These are patterns the detector's rule set doesn't cover; the qualitative review is the source of truth for design-contract violations here.

**Visual overlays:** Browser visualization skipped — no dev server detected on ports 5173, 4173, 3000, or 8080. No user-visible overlay is available this run. To get visual overlays, start the dev server (`bun run dev` or `cd dashboard && bun run dev`) and re-run `/impeccable critique`.

## Overall Impression

This is a genuinely above-average internal tool UI. The density, type scale, component vocabulary, and a11y baseline (listbox semantics, skip link, aria-live) are the right choices and executed well. The score (28/40) reflects "clearly usable, clearly above average, clearly not best-in-class." The gaps are concentrated in three areas: color token discipline (5 escape-hatch colors), motion a11y (missing `prefers-reduced-motion` — a direct DESIGN.md contract violation), and error-recovery depth (config errors toast-only, no staleness indicator during WS outage). All fixable without reinventing the committed design system.

The single biggest opportunity: **surface the TTL stamping in the capture detail.** The product's headline feature is invisible in the product's own inspector. Converting the dashboard from "viewer" to "verifier" would directly serve the "practice what you preach" principle and differentiate the tool from generic API inspectors.

## What's Working

1. **Skeleton-first loading everywhere.** `ListSkeleton` mirrors the real row layout; `DetailSkeleton` exists; `AsyncState` enforces loading→error→empty→children priority. Correct product-register pattern, applied consistently. No spinner-in-content anywhere.

2. **Virtualized listbox with correct ARIA.** `role="listbox"` + `role="option"` + `aria-activedescendant` + `aria-selected` + keyboard nav (`useCaptureListbox`) + `focus-visible:ring-2 ring-inset`. This is the hardest a11y pattern to get right and it's done properly.

3. **Capture row density.** Eight metrics (size↑↓, duration, TTFT, TPS, in/out tokens, cache %) in 76px with `tabular-nums` and `title` tooltips. Exactly the "density without noise" the product brief asks for. This is where the "engineered, on your side" personality shows.

## Priority Issues

### [P1] Side-stripe selection indicator violates absolute bans
**What:** `capture-row-item.tsx:46` — `selected && "bg-accent border-l-[3px] border-l-primary pl-[11px]"`. A 3px left border in `--primary` marks the selected capture.
**Why it matters:** The #1 item on the absolute-bans list ("Side-stripe borders... Never intentional"). Visually noisy: competes with the `text-primary` method badge in the same hue. The `bg-accent` fill already conveys selection; the stripe is redundant decoration.
**Fix:** Drop `border-l-[3px] border-l-primary pl-[11px]`. Keep `bg-accent`. If a stronger selected state is needed, add a 2px inset ring (`shadow-[inset_2px_0_0_0_hsl(var(--primary))]`) or use a more saturated `bg-accent` + `font-medium` on path text.
**Suggested command:** `/impeccable quieter` or `/impeccable distill`

### [P1] Missing `prefers-reduced-motion` (violates own DESIGN.md contract)
**What:** Zero `@media (prefers-reduced-motion: reduce)` rules anywhere in `dashboard/src`. `status-dot.tsx:30`, `skeleton.tsx:4`, `performance-meter.tsx:38` apply `animate-pulse`/`animate-spin` unconditionally.
**Why it matters:** DESIGN.md §"Focus & Motion" explicitly states the WS-down pulse "must be reduced-motion safe." It's not "later phases" anymore — this is a shipped contract violation. WCAG 2.1 SC 2.3.3 is a AA requirement.
**Fix:** Add to `index.css`:
```css
@media (prefers-reduced-motion: reduce) {
  .animate-pulse, .animate-spin { animation: none; }
}
```
**Suggested command:** `/impeccable harden`

### [P1] Color token drift (5 hardcoded colors bypass committed palette)
**What:** Five locations use raw Tailwind/hex colors instead of committed `--warning`/`--success` tokens:
- `gate-status.tsx:46` — `text-[#ffcb82]` → `text-warning-foreground`
- `gate-status.tsx:75` — `bg-yellow-500` → `bg-warning-foreground` or new `--warning-bar`
- `ws-status-badge.tsx:53` — `text-green-500` → `text-success-foreground`
- `config-tab.tsx:154` — `text-amber-500` → `text-warning-foreground`
- `config-tab.tsx:176` + `config-fields.tsx:44` — `text-amber-500` → `text-warning-foreground`
**Why it matters:** DESIGN.md states "no component may introduce a color not declared in this file first." `text-amber-500` (#f59e0b) vs `text-warning-foreground` (HSL 38 92% 28%) are perceptibly different; in dark mode the divergence worsens.
**Fix:** Replace all 5 with matching semantic tokens. For the capacity-bar mid-state, introduce `--warning-bar` if the existing foreground is too dark for a bar fill.
**Suggested command:** `/impeccable colorize` or `/impeccable harden`

### [P2] Config errors are toast-only; no inline field validation
**What:** `config-tab.tsx:55-58` — validation errors render as `toast.error("Validation failed", { description: r.errors.join("\n") })`. Multiple errors concatenate into one auto-dismissing toast. No field-level error display.
**Why it matters:** A user with 4 validation errors must read all 4, map each to a field, and fix them before the toast vanishes, with no persistent record. The single biggest emotional valley in the config flow.
**Fix:** Pipe field-keyed errors into per-field `aria-invalid` + an error `<p>` below each input. Keep the toast as a summary ("3 fields need attention").
**Suggested command:** `/impeccable harden` or `/impeccable clarify`

### [P2] No staleness indicator during WS outage
**What:** When `wsState === "down"`, `WsStatusBadge` shows the state, but the capture list shows no visual response. Rows remain at full opacity; no "last updated" timestamp; no "stale" ribbon.
**Why it matters:** A developer debugging under time pressure whose proxy crashed will keep clicking stale rows. The emotional valley is "why isn't this loading?" with no answer from the UI.
**Fix:** When `wsState !== "live"`, apply `opacity-60` to the list container and add a thin "stale — reconnecting" banner. Optionally store `lastUpdatedAt` and show "updated 12s ago" when stale > 5s.
**Suggested command:** `/impeccable harden` or `/impeccable onboard`

### [P3] Clear dialog confirm button label is "Continue"
**What:** `clear-confirm-dialog.tsx:40` — `<AlertDialogAction>Continue</AlertDialogAction>` for a destructive clear.
**Why it matters:** "Continue" is ambiguous — continue to do what? For a destructive action, the button should restate the action.
**Fix:** Change label to `Clear {count}` or just `Clear`. Keep the `bg-destructive` styling.
**Suggested command:** `/impeccable clarify`

## Persona Red Flags

### Alex (Impatient Power User)
1. **No keyboard shortcuts for top-level tabs.** Alex expects Cmd+1/2/3/4 to jump Captures/Vision/Performance/Config. Must Tab through header + mode toggle + tab list — 5+ Tab presses to reach captures.
2. **No filter/search in capture list.** 200 captures, wants the one with `cache_read_tokens > 0` — only affordance is scroll. Major friction for the power user the tool is built for.
3. **Copy copies active tab's source only.** To get request + response together, must copy twice and concatenate manually.
4. **TTL stamping not visible in detail.** The product's headline feature is invisible in the inspector. No "TTL: 1h ✓ stamped" affordance, no diff, no highlight of the `cache_control` block. Alex must manually scan JSON to confirm stamping.

### Sam (Accessibility-Dependent)
1. **Reduced-motion missing (see P1).** Vestibular-sensitive users get continuous pulse on every skeleton and WS-reconnect. Blocking for this user.
2. **Gate-status density without semantics.** "boxed", "deprioritized", "usage: stale" have no tooltips and no `aria-describedby` glossary. A screen reader reads "boxed:reason text" with no explanation.
3. **Capture-row metrics rely on `title` attributes.** `title` is not announced by most screen readers by default and is inaccessible on touch devices. Should be `aria-label` or visible sr-only text.

### "Developer debugging LLM APIs under time pressure" (project-specific)
1. **No filter by status code.** To find the one 500-errored capture in a batch of 50, must scroll and eyeball StatusBadges. High friction at the exact moment of need.
2. **TTL stamping not surfaced** (same as Alex #4). To confirm the stamp was applied, must open Request Body and scan JSON for `cache_control`. No highlight, no "stamped ✓" indicator.
3. **Clear-all is the only list operation.** Can't clear a single capture, can't pin/archive the important one before clearing. If the dev wants to keep the 500-errored capture while clearing the rest, they can't.
4. **Copy confirmation resets in 1.2s.** `capture-detail.tsx:70` — if the developer looks away for >1.2s, they miss the "Copied!" confirmation and may re-copy.

## Minor Observations

- `App.tsx:57` + `capture-detail.tsx:50` — two sources of truth for "Copy" text, synced via `onCopyStatus` callback. Works but is a smell.
- `capture-list.tsx:33` — `ROW_HEIGHT = 76` duplicated in `skeleton-templates.tsx` and the virtualizer. Three places to update if row layout changes.
- `config-tab.tsx:139` — toolbar is `flex` with 4 buttons + status; no `flex-wrap` set. Wraps awkwardly on narrow widths.
- `gate-status.tsx:71-78` — capacity bar uses inline `style={{ width: ... }}` instead of a CSS var or Tailwind `w-[...]`.
- `performance-meter.tsx:143` — `uppercase tracking-wide` on StatTile label is a tiny eyebrow. One occurrence (not "on every section") so doesn't trip the absolute-ban, but it's the closest the codebase comes.
- `capture-detail.tsx:110` — `text-[15px]` is a one-off pixel size not in DESIGN.md's type scale. Minor drift.
- `master-detail-layout.tsx:81` — Sheet is `w-[380px]` with `sm:max-w-[380px]`. On a 320px phone, the drawer is wider than the viewport. Should be `w-[min(380px,100vw)]`.
- `vision-calls.tsx:72` — `Card className="p-3 gap-2"` overrides default Card padding; Card used differently than in performance-meter (`<CardContent className="p-4">`). Minor inconsistency.

## Questions to Consider

1. **Where is the TTL?** The product's headline feature is "stamps `ttl` onto `cache_control` ephemeral blocks." The dashboard's primary job is to inspect what the proxy did. Yet nowhere in the capture detail does the UI say "TTL: 1h — stamped ✓" or highlight the `cache_control` block. The feature that defines the product is invisible in the product's own inspector. *What if the detail panel had a "Stamps" affordance — a badge or highlighted JSON path — that makes the proxy's active intervention visible?*

2. **Why is "Clear" the only list operation?** A developer who found the one 500-errored capture wants to keep it and clear the rest, or pin it, or export it. The list is a ring buffer of 1000 — the important capture will age out. *What if the list supported pin/export as first-class operations alongside clear?*

3. **Why are Config errors ephemeral?** The config tab is the one place where a mistake has consequences. Yet errors live in toasts that vanish. *What if the config tab had a persistent validation panel — a non-dismissable strip showing "3 fields need attention" with jump-to-field links — instead of relying on the user to read and remember a toast?*
