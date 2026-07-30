# Dashboard design system

Single source of truth for visual, motion, and accessibility decisions in
the `dashboard/` React app. Every token is backed by `src/index.css`,
`tailwind.config.ts`, or `components.json`; no component may introduce a
color, spacing value, or font size not declared here.

## Design tokens source

- **shadcn/ui style:** `base-nova` (Base UI preset, Nova theme. Lucide
  icons, Inter font)
- **Primitive library:** `@base-ui/react@1.6.0`. Base UI only. No
  `@radix-ui/*` packages. Every component in `src/components/ui/` MUST be
  a stock shadcn Base UI wrapper; extend via `className` / `render` prop,
  never by forking the primitive.
- **Base color:** neutral
- **Theming mode:** CSS variables via `data-theme` / `.dark` class
- **Tailwind config:** `dashboard/tailwind.config.ts`
- **Global styles:** `dashboard/src/index.css` (HSL tokens)
- **Component aliases:** `@/components`, `@/components/ui`, `@/lib/utils`,
  `@/lib`, `@/hooks`

> **Why Base UI, not Radix.** Radix's `ScrollArea` defaulted to
> `type="hover"`, which has no touch equivalent, so the thumb never appeared
> on mobile. Base UI drops that prop and drives thumb visibility through
> `data-hovering` / `data-scrolling` attributes, which work across pointer
> and touch. The mandate also removes `asChild` (replaced by `render`) and
> standardizes `data-open` / `data-closed`. No new primitive may be
> introduced that is not from `@base-ui/react`.

## Palette

All tokens are HSL, defined in `src/index.css`. The full token list lives
there. Copy tables here go stale.

### Color strategy

**Restrained, near-neutral with a violet accent.** The Nova preset ships a
grayscale identity so that the data the tool captures (HTTP methods, status
codes, SSE streams) carries the only color on screen. Semantic accents
(`destructive` red, `warning` amber, `success` green, `info` blue) remain
the saturated status hues.

**Chromatic accent for functional color.** Violet (HSL 263°) is used for
focus rings (`--ring`), chart series (`--chart-1` through `--chart-5`), and
`--sidebar-primary`. The hue is distinct from both the neutral base palette
and the traffic-light status colors.

### Semantic aliases

Components reference these tokens via Tailwind classes. New components MUST
use the same aliases, not raw color values.

| Alias | Purpose |
|-------|---------|
| `bg-background` / `text-foreground` | App surface + body text |
| `bg-card` / `text-card-foreground` | Sidebar / panel surfaces |
| `bg-popover` / `text-popover-foreground` | Floating layers (Tooltip, Menu, Select, Sheet) |
| `bg-primary` / `text-primary-foreground` | Primary action (Button default) |
| `bg-secondary` / `text-secondary-foreground` | Secondary surfaces |
| `bg-muted` / `text-muted-foreground` | Inactive chrome, metadata text |
| `bg-accent` / `text-accent-foreground` | Hover/active row tint |
| `bg-destructive` / `text-destructive-foreground` | Destructive actions, error status |
| `border-border` / `border-input` | Dividers, input borders |
| `ring-ring` | Focus ring |

### Status → Badge variant mapping

HTTP status classes use the shadcn Badge Custom Colors pattern: Tailwind
palette classes via `className` from `@/lib/badge-colors`, layered on the
`secondary` stock variant:

| `statusClass()` | Badge `variant` | Semantic `className` |
|-----------------|-----------------|----------------------|
| `ok` (2xx/3xx) | `secondary` | `badgeSuccess` (green) |
| `info` | `secondary` | `badgeInfo` (blue) |
| `warn` (4xx) | `secondary` | `badgeWarning` (amber) |
| `err` (5xx) | `destructive` | N/A |
| `""` (unknown) | `secondary` | N/A |

The same constants (`badgeSuccess`, `badgeWarning`, `badgeInfo`) are reused
for non-HTTP badges with matching semantics: WebSocket live/down, capture
queued/running/live, vision call ok/cache_hit, gate priority high/low/stale,
config experimental/Umans API badges.

## Typography

- **Body / sans:** `Inter Variable` (via `@fontsource-variable/inter`),
  Tailwind `font-sans` / default `font-family`. Nova preset default; no
  manual font stacks.
- **Monospace (Tailwind):** `ui-monospace`, `"SF Mono"`, `Menlo`, `monospace`
- **Method badge text:** `font-mono text-[11px] font-bold`. One-off pixel
  size for HTTP verbs only
- **Row metadata:** `text-[11px] text-muted-foreground tabular-nums`

No other custom font sizes or line heights; use Tailwind's default type
scale (`text-xs`, `text-sm`, `text-base`, `text-lg`, etc.).

## Radius & spacing

- **Base radius:** `--radius: 0.625rem` (Nova preset default)
- **Derived radii:** Tailwind's `rounded-sm` / `rounded-md` / `rounded-lg`
  map onto `calc(var(--radius) - <offset>)`. No custom radius utilities.
- **Badge radius:** `rounded-full` (pill)
- **Spacing:** Tailwind default scale. Observed rhythms:
  - Section padding: `px-4 py-3`
  - Inline gap: `gap-1.5`, `gap-2`, `gap-3`
  - Compact controls: `h-7`, `h-8`, `h-9`, `px-3`
  - List row padding: `px-4 py-2`

The `.scrollbar-none` utility in `src/index.css` is the only scrollbar
override. It hides the gutter on horizontally-scrolling tab strips on mobile.

## Focus & motion

- **Focus rings:**
  - `Button`: `focus-visible:border-ring focus-visible:ring-3
    focus-visible:ring-ring/50` with `focus-visible:outline-none` (Nova
    preset). `ring-3` (not `ring-1`) widens for visibility.
  - `Badge`: `focus:ring-2 focus:ring-ring focus:ring-offset-2`.
  - Interactive rows (`CaptureRowItem`) and WS status button:
    `focus-visible:ring-2 focus-visible:ring-ring rounded`.
- **Color transitions:** `transition-colors` on `Button`, `Badge`, and
  interactive list rows (`hover:bg-accent`).
- **Functional motion:** WebSocket "down" state uses `animate-pulse` on the
  status dot. Must be reduced-motion safe.
- **No layout animation:** `transform`/`opacity` only if motion is added;
  the virtualized list uses absolute positioning with `translateY`.
- **Reduced motion:** `@media (prefers-reduced-motion: reduce)` in
  `src/index.css` disables transitions and animations globally. Any new
  motion MUST be covered by this block.

## Accessibility contract

1. **Single h1:** Exactly one top-level `<h1>` ("umans-gate"). Region
   headers use `<h2>` or are visually-hidden.
2. **Listbox semantics:** Virtualized capture list rows are `role="option"`
   / `aria-selected` inside a `role="listbox"` container.
3. **Live region:** WebSocket status changes announced via `aria-live`
   `polite`.
4. **Contrast:** All functional text/background pairs meet WCAG AA (4.5:1)
   for small text; non-text UI components (focus rings, inputs, functional
   borders, chart series) meet WCAG 1.4.11 (3:1) in both themes. Decorative
   borders (`--border`) are exempt. Light theme brought into compliance by
   darkening `--muted-foreground`, `--input`, `--border` and introducing
   violet (263°) for `--ring`, `--chart-*`, `--sidebar-primary`. Dark theme
   by darkening `--destructive` (56%→52%) and `--sidebar-primary` (65%→60%),
   increasing `--input` alpha (15%→35%), gaining the same violet accent.
5. **Keyboard-first:** All interactive elements reachable and operable by
   keyboard; focus rings not removed without a replacement.
6. **No emoji icons:** SVG icon sets only (`lucide-react`).

## Primitives inventory

### Base UI only

Every file in `src/components/ui/` wraps `@base-ui/react`. Local
modifications documented so they are not reverted by a future
`shadcn add`:

| File | Local change vs. stock `base-nova` | Reason |
|------|-------------------------------------|--------|
| `scroll-area.tsx` | Restored custom `viewportRef?: React.Ref<HTMLDivElement>` prop | `capture-list.tsx` feeds the viewport to `@tanstack/react-virtual`. Stock shadcn drops this prop. |
| `tabs.tsx` | `TabsList` defaults `activateOnFocus` to `true` | Preserves original Radix keyboard behavior (ArrowRight both focuses and activates) |
| `alert-dialog.tsx` | `AlertDialogAction` wraps `AlertDialogPrimitive.Close` with `render={<Button …/>}` | Radix's `Action` auto-closed the dialog; stock Base UI did not |
| `button.tsx` | `size` prop type widened to include `"icon-xs" \| "icon-sm" \| "icon-lg"` | cva `VariantProps` loses literal-string types; `sheet.tsx` passes `size="icon-sm"` |

Any future `shadcn add --overwrite` on these files will revert the local
changes; re-apply from this table.

### Existing shadcn/ui primitives (`src/components/ui/`)

`alert-dialog.tsx`, `badge.tsx`, `button.tsx`, `card.tsx`,
`dropdown-menu.tsx`, `input.tsx`, `label.tsx`, `pagination.tsx`,
`scroll-area.tsx`, `select.tsx`, `separator.tsx`, `skeleton.tsx`,
`sonner.tsx`, `switch.tsx`, `table.tsx`, `tabs.tsx`, `textarea.tsx`,
`tooltip.tsx`.

Custom Badge variants (`sse`, `proto`, etc.) are **not** wired in. Only
`default`, `secondary`, `destructive`, `outline`.

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
│   │       │   ├── WsStatusBadge (Badge + Tooltip)
│   │       │   ├── GateStatus
│   │       │   └── VirtualizedRows (CaptureRowItem)
│   │       └── CaptureDetailPanel
│   ├── TabsContent "vision" → VisionCalls (lazy)
│   ├── TabsContent "performance" → PerformanceMeter (lazy)
│   ├── TabsContent "economics" → EconomicsTab (lazy)
│   ├── TabsContent "usage" → UsageTab (lazy)
│   ├── TabsContent "models" → ModelsTab (lazy)
│   └── TabsContent "config" → ConfigTab (lazy)
└── Toaster
```

Dashboard tabs (App.tsx wiring): captures, vision, performance, economics,
usage, models, config. Vision/performance/economics/usage/models/config
are lazy-loaded. Also lazy: `ModeToggle`, `UpdateIndicator`. Non-lazy:
`CaptureList`, `CaptureDetailPanel` (always loaded for captures tab).

## Accepted debt

1. **Fixed-width capture list (desktop).** Sidebar locked to
   `w-[380px]`. On mobile, rendered inside a `Sheet` clamped to
   `w-3/4 sm:max-w-sm`. Adaptive width deferred.
2. **BodyRenderer edge-case branches preserved.** Several branches for
   unusual content types (empty bodies, non-JSON, binary). Preserved as-is
   to avoid regressions.
3. **No route-level code splitting.** Dashboard is a single bundle.
   Acceptable for an internal tool.
4. **No external error-monitoring.** Runtime errors surface via Sonner
   toasts and the console.

## Mobile responsiveness

Desktop-first; mobile supported via these patterns. Any new tab or panel
MUST follow them.

- **Top-level tabs:** `TabsList` wrapped in
  `.tab-scroll flex-1 min-w-0 overflow-x-auto overflow-y-hidden
  scrollbar-none`. Two utilities in `src/index.css`: `.scrollbar-none`
  hides the scrollbar gutter; `.tab-scroll` applies a right-edge
  `mask-image` fade on mobile only (`max-width: 767px`). On `md+` the
  `TabsList` is `w-full`.
- **Master/detail (captures tab):** `md+` is a flex row (sidebar
  `w-[380px] shrink-0` + detail `flex-1 min-w-0`). Below `md`, the capture
  list is rendered inside a left `Sheet` (`master-detail-layout.tsx`);
  selecting a row closes the sheet.
- **Sheet width on mobile:** `SheetContent` uses
  `data-[side=left]:w-[85vw] data-[side=left]:sm:w-[380px]`. The
  `data-[side=left]` prefix is required so `tailwind-merge` deduplicates
  against the stock `data-[side=left]:w-3/4`.
- **Capture list height chain:** The `CaptureList` root `<aside>` MUST be
  `h-full w-full min-w-0 flex-col`. The `ScrollArea` must be
  `min-h-0 flex-1 overflow-hidden` so the flex child can shrink below
  content size and produce a scroll range.
- **Capture list scrolling:** `ScrollArea` wraps the virtualized list.
  Base UI's `ScrollArea` has no `type="hover"` default; the thumb appears on
  touch via `data-scrolling` / `data-hovering`. Thumb uses
  `bg-muted-foreground/40 hover:bg-muted-foreground/60` (NOT `bg-border`).
  Do not re-introduce a hover-only thumb or a `bg-border` thumb.
- **Header:** `MobileDrawerTrigger` (hamburger) is `md:hidden`; the full
  `TabsList` + `ModeToggle` chrome is shown from `md` up.
