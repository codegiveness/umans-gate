# Light theme contrast revamp — darken neutrals + violet chromatic accent

## Status

Accepted

## Date

2026-07-23

## Context

The dashboard's light theme used pure neutral grayscale for all CSS custom properties (HSL hue 0, saturation 0). WCAG 2.2 AA contrast analysis revealed multiple failures: `--muted-foreground` at 3.0:1 (needs 4.5:1 for text), `--ring` at 2.1:1 (needs 3:1 for focus indicators), `--chart-1` at 1.3:1 (needs 3:1 for graphical objects), `--input` at 1.2:1 (needs 3:1 for functional UI). The dark theme was legible for text but all five chart colors were grayscale, making data series visually indistinguishable. The dark theme also carried a violet accent on `--sidebar-primary` that the light theme did not mirror, creating inconsistent brand identity.

## Decision

Adopt a "darken + chromatic accent" strategy:

1. Darken the failing neutral tokens (`--muted-foreground` to 44%, `--input` to 58%, `--border` to 85%) to meet WCAG AA thresholds.
2. Introduce violet (HSL 263°) as the chromatic accent for `--ring`, `--sidebar-primary`, and `--sidebar-ring` in light theme, aligning with the dark theme's existing violet.
3. Replace the five-step grayscale chart palette with a five-hue palette (violet, cyan, amber, rose, teal) in both themes, tuned per-theme for contrast.
4. Extend `--ring` and `--sidebar-ring` in dark theme to the same violet hue.

## Alternatives considered

### Path A — Darken only the failing neutral tokens

Keep `baseColor: neutral` (pure grayscale). Just lower the lightness of the failing tokens.

Rejected because:

- A gray focus ring on a gray background can never be perceptually distinct enough regardless of lightness.
- Five grayscale chart series are visually indistinguishable as data — contrast against the background is necessary but not sufficient; series must also be distinguishable from each other.
- The fix would address legibility but not the structural data-viz usability problem.

### Path B — Switch baseColor from neutral to zinc or slate

Rejected because: research via the shadcn/ui registry confirmed that `muted-foreground` stays at ~55% lightness and `ring` stays at ~70% lightness across all neutral-ish baseColors (neutral, zinc, stone, slate, gray). The hue changes; the lightness — and therefore the contrast ratio — does not. A baseColor swap is a perceptual trick, not a contrast fix.

### Path C — Darken + chromatic accent (chosen)

Darken the failing neutrals *and* introduce a violet chromatic accent for functional color (focus rings, chart series, sidebar-primary). This path fixes both the contrast failures and the perceptual-distinguishability problem, while unifying brand identity across light and dark themes.

## Consequences

- All functional token pairs now meet WCAG 2.2 AA in both themes.
- The accent hue (violet 263°) is now part of the design system vocabulary, documented in the glossary as "Accent Hue".
- `dashboard/DESIGN.md` was corrected to accurately describe the color format (HSL) and compliance status.
- Automated contrast tests in `app-a11y.test.tsx` prevent regressions.
- The `--border` token at 85% lightness achieves only 1.41:1 but qualifies for the WCAG 1.4.11 decorative-border exemption.
- Future chart additions must use the established five-hue palette, not arbitrary colors.
