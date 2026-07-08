# Dashboard Design System

This document is the single source of truth for all visual, motion, and
accessibility decisions in the `dashboard/` React application. Every token listed
here is backed by `src/index.css`, `tailwind.config.ts`, or `components.json`;
no component may introduce a color, spacing value, or font size that is not
declared in this file first.

## Design Tokens Source

- **shadcn/ui style:** `base-nova` (Base UI preset, Nova theme — Lucide icons, Geist font)
- **Primitive library:** `@base-ui/react@1.6.0` — **Base UI only.** No `@radix-ui/*`
  packages, no hand-rolled primitives. Every component in `src/components/ui/`
  MUST be a stock shadcn Base UI wrapper; if a behavior is missing, extend via
  the wrapper's `className` / `render` prop, never by forking the primitive.
- **Base color:** neutral
- **Theming mode:** CSS variables via `data-theme` / `.dark` class
- **Tailwind config:** `dashboard/tailwind.config.ts`
- **Global styles:** `dashboard/src/index.css` (OKLCH tokens)
- **Component aliases:** `@/components`, `@/components/ui`, `@/lib/utils`, `@/lib`, `@/hooks`

> **Why Base UI, not Radix.** Radix's `ScrollArea` defaulted to `type="hover"`,
> which has no touch equivalent — the thumb never appeared on mobile capture
> lists. Base UI drops that prop entirely and drives thumb visibility through
> `data-hovering` / `data-scrolling` data attributes, which work identically
> across pointer and touch. The mandate also removes `asChild` (replaced by
> `render`) and standardizes `data-open` / `data-closed` over Radix's
> `data-[state=open]`. No new primitive may be introduced that is not from
> `@base-ui/react`.

## Palette

All tokens are OKLCH, defined in `src/index.css` and exposed as Tailwind color
aliases in `tailwind.config.ts`. The full token list (background, foreground,
card, popover, primary, secondary, muted, accent, destructive, border, input,
ring, chart-*, sidebar-*) lives in `src/index.css`; that file is the source of
truth — copy tables here go stale.

### Color strategy

**Restrained, near-neutral.** The Nova preset ships a grayscale identity
(OKLCH chroma 0 across light and dark) so that the data the tool captures —
HTTP methods, status codes, SSE streams — carries the only color on screen.
Semantic accents (`destructive` red, `chart-*` series) are the sole saturated
hues. This is a deliberate shift from the previous azure (hue 212) primary:
the earlier accent fought the traffic-light status colors and left focus rings
hard to distinguish from selection state on the capture list. Grayscale primary
+ colored status is the cleaner information hierarchy for a capture tool.

### Semantic aliases used by components

Components reference these tokens via Tailwind classes. Any new component MUST
use the same aliases rather than raw color values.

| Alias | Purpose |
|-------|---------|
| `bg-background` / `text-foreground` | App surface + body text |
| `bg-card` / `text-card-foreground` | Sidebar / panel surfaces |
| `bg-popover` / `text-popover-foreground` | Floating layers (Tooltip, Menu, Select, Sheet) |
| `bg-primary` / `text-primary-foreground` | Primary action (Button default) |
| `bg-secondary` / `text-secondary-foreground` | Secondary surfaces (Badge secondary, Tabs inactive) |
| `bg-muted` / `text-muted-foreground` | Inactive chrome, metadata text |
| `bg-accent` / `text-accent-foreground` | Hover/active row tint |
| `bg-destructive` / `text-destructive-foreground` | Destructive actions, error status |
| `border-border` / `border-input` | Dividers, input borders |
| `ring-ring` | Focus ring |

### Status → Badge variant mapping

HTTP status classes map to the four stock Badge variants (no custom variants):

| `statusClass()` | Badge `variant` |
|-----------------|-----------------|
| `ok` (2xx/3xx) | `default` |
| `info` | `secondary` |
| `warn` (4xx) | `outline` |
| `err` (5xx) | `destructive` |
| `""` (unknown) | `secondary` |

The previously-documented custom Badge variants (`sse`, `proto`, `queued`,
`running`, `success`, `warning`) and the `success` / `warning` / `info` /
`sse` / `json-*` color tokens were **never wired into components**; they were
aspirational and have been removed from the token file. If a future feature
needs a semantic accent, add the OKLCH token to `src/index.css` first, register
it here, then reference it.

## Typography

- **Body / sans:** `Geist Variable` (loaded via `@fontsource-variable/geist`),
  exposed as the Tailwind `font-sans` / default `font-family`. Nova preset
  default; no manual font stacks in components.
- **Monospace stack (Tailwind):** `ui-monospace`, `"SF Mono"`, `Menlo`, `monospace`
- **Method badge text:** `font-mono text-[11px] font-bold` — one-off pixel size for HTTP verbs only
- **Row metadata:** `text-[11px] text-muted-foreground tabular-nums`

No other custom font sizes or line heights are defined; use Tailwind's default
type scale for `text-xs`, `text-sm`, `text-base`, `text-lg`, etc.

## Radius & Spacing

- **Base radius:** `--radius: 0.625rem` (Nova preset default)
- **Derived radii:** Tailwind's `rounded-sm` / `rounded-md` / `rounded-lg` map
  onto `calc(var(--radius) - <offset>)` per the Tailwind config; no custom
  radius utilities are defined.
- **Badge radius:** `rounded-full` (pill)
- **Spacing convention:** Tailwind default scale. Component-internal rhythms
  observed in the baseline:
  - Section padding: `px-4 py-3`
  - Inline gap: `gap-1.5`, `gap-2`, `gap-3`
  - Compact controls: `h-7`, `h-8`, `h-9`, `px-3`
  - List row padding: `px-4 py-2`

The baseline does **not** include a global custom scrollbar stylesheet. The
`.scrollbar-none` utility in `src/index.css` is the only scrollbar override —
it hides the scrollbar gutter on horizontally-scrolling tab strips on mobile
while preserving touch scrolling.

## Focus & Motion

- **Focus rings:**
  - `Button` uses `focus-visible:border-ring focus-visible:ring-3
    focus-visible:ring-ring/50` with a `focus-visible:outline-none` reset
    (Nova preset). `ring-3` (not `ring-1`) widens the ring for visibility.
  - `Badge` uses `focus:ring-2 focus:ring-ring focus:ring-offset-2`.
  - Interactive rows (e.g. `CaptureRowItem`) and the WS status button use
    `focus-visible:ring-2 focus-visible:ring-ring rounded`.
- **Color transitions:** `transition-colors` is applied to `Button`, `Badge`, and
  interactive list rows (`hover:bg-accent`).
- **Functional motion:** The WebSocket "down" state uses `animate-pulse` on the
  status dot to signal connection loss. This is informational motion and must be
  reduced-motion safe (`@media (prefers-reduced-motion: reduce)` should freeze or
  hide the pulse in later phases).
- **No layout animation:** `transform`/`opacity` only if motion is added; the
  virtualized list already uses absolute positioning with `translateY` for
  scrolling.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` in
  `src/index.css` disables transitions and animations globally. Any new motion
  MUST be covered by this block or an equivalent per-component override.

## Accessibility Contract

1. **Single h1:** The application shell exposes exactly one top-level `<h1>`
   ("umans-gate"). Region headers inside sidebars/cards use `<h2>` or are
   visually-hidden labels.
2. **Listbox semantics:** The virtualized capture list rows are implemented as
   `role="option"` / `aria-selected` selectable items inside a `role="listbox"`
   container.
3. **Live region:** WebSocket status changes are announced via an `aria-live`
   region with `polite` so screen-reader users know when the list is stale.
4. **Contrast:** All text/background pairs meet WCAG AA (4.5:1) for small
   text. Semantic token pairs (`success`, `warning`, `info`, `sse`,
   `destructive`) were adjusted in T13b to pass AA in both light and dark
   themes.
5. **Keyboard-first:** All interactive elements are reachable and operable by
   keyboard; focus rings are not removed without a replacement.
6. **No emoji icons:** Use SVG icon sets only (`lucide-react`). Emojis are not
   used as semantic icon replacements.

## Primitives Inventory

### Primitive library — Base UI only

Every file in `src/components/ui/` wraps `@base-ui/react`. The stock shadcn
`base-nova` wrappers are the baseline; the following local modifications are
documented so they are not accidentally reverted by a future `shadcn add`:

| File | Local change vs. stock `base-nova` | Reason |
|------|-------------------------------------|--------|
| `scroll-area.tsx` | Restored custom `viewportRef?: React.Ref<HTMLDivElement>` prop, forwarded to `<ScrollArea.Viewport ref={viewportRef}>` | `capture-list.tsx` feeds the viewport DOM node to `@tanstack/react-virtual` (`getScrollElement: () => viewportRef.current`). Stock shadcn drops this prop. |
| `tabs.tsx` | `TabsList` defaults `activateOnFocus` to `true` (Base UI defaults to `false`) | Preserves the original Radix keyboard behavior where ArrowRight both focuses and activates the next tab. |
| `alert-dialog.tsx` | `AlertDialogAction` wraps `AlertDialogPrimitive.Close` with `render={<Button …/>}` instead of being a plain `Button` | Radix's `Action` auto-closed the dialog; stock Base UI `AlertDialogAction` did not. |
| `button.tsx` | `size` prop type widened to include `"icon-xs" \| "icon-sm" \| "icon-lg"` literals | cva `VariantProps` loses literal-string types for hyphenated keys; `sheet.tsx` passes `size="icon-sm"` for its close button. |

Any future `shadcn add --overwrite` on these files will revert the local
changes; re-apply them from this table.

### Existing shadcn/ui primitives (`src/components/ui/`)

1. `alert-dialog.tsx` — modal confirmation dialogs
2. `badge.tsx` — semantic status pills (`default`, `secondary`, `destructive`,
   `outline`). Custom variants (`sse`, `proto`, etc.) are **not** wired in.
3. `button.tsx` — `default`, `destructive`, `outline`, `secondary`, `ghost`, `link`
4. `card.tsx` — surface containers
5. `dropdown-menu.tsx` — floating menus
6. `input.tsx` — text inputs
7. `label.tsx` — form labels (styled native `<label>`, not a Base UI primitive)
8. `scroll-area.tsx` — custom scroll containers (Base UI; `viewportRef` extension)
9. `select.tsx` — dropdown selects
10. `separator.tsx` — visual dividers
11. `skeleton.tsx` — loading placeholders
12. `sonner.tsx` — toast notifications
13. `switch.tsx` — toggles
14. `table.tsx` — tabular data
15. `tabs.tsx` — tab panels (horizontal-scroll on mobile via `App.tsx`)
16. `textarea.tsx` — multi-line inputs
17. `tooltip.tsx` — hover/focus tooltips

### Planned composite primitives

These do not exist yet. They are declared here so downstream tasks build against
a named contract.

- **StatusDot** (`src/components/status-dot.tsx`) — colored indicator used by
  `WsStatusBadge`; wraps token-driven `span` and enforces reduced-motion handling.
- **PageHeader** (`src/components/page-header.tsx`) — a reusable
  `<header>` + `<h2>` + action slot used by the application chrome and full-page
  tabs. The app-level `<h1>` lives in `App.tsx`.
- **MasterDetailLayout** (`src/components/master-detail-layout.tsx`) —
  flex row with fixed sidebar width and a stretchy detail panel; extracts the
  inline `flex h-full` layout used by the Captures tab.

### Composition tree

```text
App
├── TooltipProvider
├── header (h1 + ModeToggle)
├── Tabs
│   ├── TabsList
│   ├── TabsContent "captures"
│   │   └── MasterDetailLayout
│   │       ├── CaptureList
│   │       │   ├── PageHeader
│   │       │   ├── WsStatusBadge (Badge + StatusDot + Tooltip)
│   │       │   ├── GateStatus
│   │       │   └── VirtualizedRows (CaptureRowItem)
│   │       └── CaptureDetailPanel
│   ├── TabsContent "vision" → VisionCalls
│   ├── TabsContent "performance" → PerformanceMeter
│   └── TabsContent "config" → ConfigTab
└── Toaster
```

## Accepted Debt

The following tradeoffs are intentional in the current baseline and are
scheduled for later work:

1. **Fixed-width capture list (desktop).** The desktop sidebar is locked to
   `w-[380px]` (`min-w-[380px]`). On mobile the list is rendered inside a
   `Sheet` (Base UI Dialog) at the same width, which is wider than most phone
   viewports; the Sheet clamps to `w-3/4 sm:max-w-sm` so it fits. Adaptive
   desktop sidebar width is deferred to a later phase.
2. **BodyRenderer edge-case branches preserved.** The body renderer in
   `capture-detail.tsx` has several edge-case branches for unusual content types
   (empty bodies, non-JSON, binary). These are preserved as-is to avoid
   regressions; T4 will route the empty-body branch through a new `<EmptyState>`
   primitive but will not refactor the other branches.
3. **Bundle-size / lazy-loading deferred.** No route-level code splitting or
   lazy loading is in place. The dashboard is a single bundle. This is
   acceptable for an internal tool; deferred until a measured need arises.
4. **No external error-monitoring.** No Sentry, LogRocket, or equivalent is
   wired. Runtime errors surface via Sonner toasts and the console. Acceptable
   for the current operational scope.

## Mobile responsiveness

The app shell is designed desktop-first; mobile is supported via the following
adaptive patterns. Any new tab or panel MUST follow the same patterns.

- **Top-level tabs:** `TabsList` is wrapped in a
  `.tab-scroll flex-1 min-w-0 overflow-x-auto overflow-y-hidden scrollbar-none`
  container so the tab strip scrolls horizontally on narrow screens instead of
  wrapping or cramping. Two utilities (in `src/index.css`) make this work:
  `.scrollbar-none` hides the scrollbar gutter while preserving touch scrolling,
  and `.tab-scroll` applies a right-edge `mask-image` fade on mobile only
  (`max-width: 767px`) to signal that more tabs exist beyond the visible edge.
  On `md+` the `TabsList` is `w-full` so all tabs fit without scrolling.
- **Master/detail (captures tab):** On `md+` the layout is a flex row (sidebar
  `w-[380px] shrink-0` + detail `flex-1 min-w-0`). Below `md`, the capture list
  is rendered inside a left `Sheet` (`master-detail-layout.tsx`); selecting a
  row closes the sheet and shows the detail panel full-width.
- **Sheet width on mobile:** The mobile `SheetContent` uses
  `data-[side=left]:w-[85vw] data-[side=left]:sm:w-[380px]`. The `data-[side=left]`
  variant prefix is required so `tailwind-merge` deduplicates against the stock
  shadcn `data-[side=left]:w-3/4` in the sheet variant; an unprefixed `w-[380px]`
  would NOT override it (tailwind-merge treats them as different variants) and
  the sheet would render at 75% viewport width.
- **Capture list height chain:** The `CaptureList` root `<aside>` MUST be
  `h-full w-full min-w-0 flex-col`. Without `h-full` the aside grows to fit all
  content and the `ScrollArea` viewport has nothing to scroll
  (`clientHeight ≈ scrollHeight`). The `ScrollArea` itself must be
  `min-h-0 flex-1 overflow-hidden` so the flex child can shrink below content
  size and produce a scroll range.
- **Capture list scrolling:** `ScrollArea` wraps the virtualized list. Base UI's
  `ScrollArea` (unlike Radix's) has no `type="hover"` default, so the thumb
  appears on touch devices via `data-scrolling` / `data-hovering` data
  attributes. The thumb uses `bg-muted-foreground/40 hover:bg-muted-foreground/60`
  (NOT `bg-border`, which is near-white and invisible on `bg-card`). Do not
  re-introduce a hover-only thumb or a `bg-border` thumb.
- **Header:** The `MobileDrawerTrigger` (hamburger) is `md:hidden`; the full
  `TabsList` + `ModeToggle` chrome is shown from `md` up.
