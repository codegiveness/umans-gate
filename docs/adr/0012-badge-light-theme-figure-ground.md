# Badge light-theme figure-ground separation — medium tint over dark fill

## Status

Accepted

## Date

2026-07-24

## Context

The dashboard's light-theme semantic badges (`badgeSuccess`, `badgeWarning`,
`badgeInfo`, `badgeGold` in `dashboard/src/lib/badge-colors.ts`) used Tailwind
`*-50` shade backgrounds (~96–98% lightness) on a pure-white surface
(`--background: 0 0% 100%`). The 2–4% lightness delta between badge fill and
page background produced insufficient figure-ground separation — badges
failed to register as distinct visual objects and degenerated into "colored
text with a faint tint." The badges' function as instant-scan status
indicators was compromised.

The text contrast inside the badges (`*-900` text on `*-50` fill) was never
the problem — those pairs clear WCAG AA 7:1. The problem was purely the
badge-to-background distinction: the badge's job as a visual signal.

ADR 0010 addressed core CSS custom properties (`--muted-foreground`,
`--ring`, `--chart-*`, `--input`, `--border`) but did not cover the
badge-colors semantic constants, which live outside the token system as
direct Tailwind palette classes per the shadcn Badge Custom Colors pattern.

## Decision

Bump light-theme badge backgrounds from `*-50` to `*-100` (gold to
`*-200`), keeping text at `*-900` and dark-theme classes untouched:

| Constant | Before (light) | After (light) |
|---|---|---|
| `badgeSuccess` | `bg-green-50` (~98% L) | `bg-green-100` (~96% L) |
| `badgeWarning` | `bg-amber-50` (~98% L) | `bg-amber-100` (~95% L) |
| `badgeInfo` | `bg-blue-50` (~98% L) | `bg-blue-100` (~95% L) |
| `badgeGold` | `bg-yellow-100` (~96% L) | `bg-yellow-200` (~92% L) |

Gold uses `*-200` because yellow hues need a larger lightness delta from
white to register as a distinct fill — `yellow-100` at 96% L is too close
to the 100% background.

All four semantics use equal visual weight (same shade tier). The dark
theme already follows this equal-weight philosophy (all `*-800`, hue
differentiation only). Severity ordering (stronger tint for warnings) was
rejected to stay consistent with the dark theme and because in a capture
monitoring tool the badge's job is to classify, not prioritize — the user
scans top-to-bottom and every badge needs equal scannability.

## Alternatives considered

### Path A — Dark fill + light text (the user's initial proposal)

Use the dark-theme pattern on light theme: `bg-green-800 text-green-100`
on white background. An 80% lightness drop.

Rejected because: the dashboard shows many badges simultaneously — every
capture row carries a status badge, gate badges, WS status, cache hit
badges, and budget tier badges. A screen full of dark-fill pills is
visually loud and creates noise in a dense monitoring view. The dark
theme gets away with `*-800` because the whole surface is already dark
(14.5% L) — `green-800` (20% L) is only a 6% delta from the background,
so the pill is subtle there. On white, `*-800` is an 80% delta — it
screams. Dark fills work for a single alert in an otherwise-neutral UI
(GitHub's "closed" badge), not for a grid of status pills.

### Path B — Medium tint `*-100`/`*-200` (chosen)

Bump from `*-50` to `*-100` (gold to `*-200`). A 4–8% lightness delta
from white — enough to register as "a colored thing" without dominating
the row. This is what Linear, Vercel, and GitHub's light themes use for
status pills. Text stays at `*-900` (already passes AA 7:1), so the
within-badge contrast is unchanged.

### Path C — Pale fill + colored border

Keep `*-50` fill, add `border-*-300` for edge definition.

Rejected because: the badge component (`badge.tsx`) already uses
`border-transparent` as its base, and the shadcn Badge Custom Colors
pattern layers `className` on top of the `secondary` variant which has
its own border handling. Adding borders would require touching the
variant composition and would produce a visually different shape
(outlined pill vs. filled pill), breaking visual consistency with the
dark theme which uses filled pills. The border also adds visual weight
at the edge without improving the fill's figure-ground signal — it
trades one problem for another.

## Consequences

- Light-theme badges now have sufficient figure-ground separation from
  the white background to function as instant-scan status indicators.
- The change is isolated to `badge-colors.ts` — 4 constants, light-theme
  classes only. Dark-theme classes and the `dotSuccess`/`dotWarning`
  constants are untouched.
- 33 consumer sites (every component that renders a Badge with a semantic
  className) inherit the change automatically — no per-component edits.
- Text contrast inside badges is unchanged (`*-900` on `*-100` still
  clears AA 7:1).
- The equal-weight philosophy matches the dark theme, so light and dark
  modes present the same visual hierarchy — only the shade tier differs.
- The `app-a11y.test.tsx` contrast tests (if they cover badge
  text-on-fill pairs) should still pass — the text shade is unchanged.
