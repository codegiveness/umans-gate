# Theme contrast revamp: darken neutrals + violet chromatic accent + dark-theme fixes

## Status

Accepted

## Date

2026-07-23

## Context

umans-gate's dashboard light theme failed WCAG 2.2 AA contrast on
multiple CSS custom properties because every color was pure neutral
grayscale (HSL hue 0, saturation 0). Measured failures included
`--muted-foreground` at 3.0:1 against `--background`, `--ring` at 2.1:1,
`--chart-1` at 1.3:1, and `--input` at 1.2:1. The dark theme passed text
contrast but used grayscale chart colors, so data series were visually
indistinguishable. A follow-up audit found three additional dark-theme
failures: `--destructive-foreground` on `--destructive` at 4.13:1,
`--sidebar-primary-foreground` on `--sidebar-primary` at 3.77:1, and
`--input` at 1.62:1.

## Decision

The dashboard adopts a "darken + chromatic accent" strategy:

1. Darken the failing neutral tokens (`--muted-foreground` to 44%, `--input` to 58%, `--border` to 85%) to meet WCAG AA thresholds.
2. Introduce violet (HSL 263°) as the chromatic accent for `--ring`, `--sidebar-primary`, and `--sidebar-ring` in light theme, aligning with the dark theme's existing violet.
3. Replace the five-step grayscale chart palette with a five-hue palette (violet, cyan, amber, rose, teal) in both themes, tuned per-theme for contrast.
4. Extend `--ring` and `--sidebar-ring` in dark theme to the same violet hue.
5. Darken dark-theme `--destructive` (56%→52%) and `--sidebar-primary` (65%→60%) to meet 4.5:1 for their foreground text.
6. Increase dark-theme `--input` alpha (15%→35%) to meet 3:1.
7. Replace `text-muted-foreground` with `text-background/70` inside `TooltipContent` to maintain 4.5:1 on the inverted tooltip surface.

## Alternatives considered

### Path A: darken only the failing neutral tokens

Keep `baseColor: neutral` (pure grayscale). Just lower the lightness of the failing tokens.

Rejected because:

- A gray focus ring on a gray background can never be perceptually distinct enough regardless of lightness.
- Five grayscale chart series are visually indistinguishable as data; contrast against the background is necessary but not sufficient, because series must also be distinguishable from each other.
- The fix would address legibility but not the structural data-viz usability problem.

### Path B: switch baseColor from neutral to zinc or slate

Rejected because: research via the shadcn/ui registry confirmed that `muted-foreground` stays at ~55% lightness and `ring` stays at ~70% lightness across all neutral-ish baseColors (neutral, zinc, stone, slate, gray). The hue changes; the lightness, and therefore the contrast ratio, does not. A baseColor swap is a perceptual trick, not a contrast fix.

### Path C: darken + chromatic accent (chosen)

Darken the failing neutrals *and* introduce a violet chromatic accent for functional color (focus rings, chart series, sidebar-primary). This path fixes both the contrast failures and the perceptual-distinguishability problem, while unifying brand identity across light and dark themes.

## Consequences

- All functional token pairs now meet WCAG 2.2 AA in both themes.
- The accent hue (violet 263°) is now part of the design system vocabulary, documented in the glossary as "Accent Hue".
- `dashboard/DESIGN.md` was corrected to accurately describe the color format (HSL) and compliance status.
- Automated contrast tests in `app-a11y.test.tsx` prevent regressions, including button-foreground-on-fill pairs, tooltip secondary text, and dark-theme `--input`.
- The `--border` token at 85% lightness achieves only 1.41:1 but qualifies for the WCAG 1.4.11 decorative-border exemption.
- Dark-theme `--sidebar-primary` at 60% lightness yields 2.56:1 as a UI fill against the sidebar background (below 3:1), but the button is identifiable via its visible white text (4.70:1); WCAG 1.4.11 allows text to establish component identity.
- Future chart additions must use the established five-hue palette, not arbitrary colors.
