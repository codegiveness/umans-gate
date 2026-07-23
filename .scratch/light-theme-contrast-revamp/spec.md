# Spec: Light theme contrast revamp

Status: ready-for-agent

## Problem Statement

When the dashboard is set to light theme, large parts of the interface are
illegible or near-invisible. Muted secondary text (timestamps, descriptions,
helper labels) fails WCAG 2.2 AA contrast thresholds. Focus rings are
invisible when tabbing through buttons and inputs — a keyboard accessibility
violation. Chart colors are so light they vanish on the white background.
Borders between sections are barely perceptible.

The dark theme is legible, but has its own structural problem: all five
chart colors are grayscale, making data series visually indistinguishable
from one another. The dark theme also carries a violet accent on
`--sidebar-primary` that the light theme does not mirror, creating an
inconsistent brand identity across themes.

The design system documentation (`dashboard/DESIGN.md`) falsely claims the
tokens are defined in OKLCH and that all token pairs meet WCAG AA — neither
is true.

## Solution

Revamp the CSS custom-property token values in `dashboard/src/index.css`
so that every functional token pair meets WCAG 2.2 AA contrast thresholds
in both light and dark themes. Introduce a violet/indigo chromatic accent
for focus rings and chart colors, aligning the light theme's
`--sidebar-primary` with the dark theme's existing violet. Replace the
five-step grayscale chart palette with a five-hue palette (violet, cyan,
amber, rose, teal) so data series are visually separable. Correct the
DESIGN.md documentation to reflect the actual color format (HSL, not OKLCH)
and the now-genuine AA compliance. Record the decision as an ADR and add
glossary terms to CONTEXT.md.

## User Stories

1. As a dashboard user working in a bright environment, I want muted
   secondary text to be clearly legible in light theme, so that I can
   read timestamps, descriptions, and helper labels without straining.

2. As a dashboard user who navigates by keyboard, I want focus rings to
   be clearly visible in light theme, so that I can see which element
   currently has focus.

3. As a dashboard user who navigates by keyboard, I want focus rings to
   be clearly visible in dark theme, so that keyboard navigation works
   in both themes.

4. As a dashboard user viewing charts, I want each chart series to have
   a distinct, perceptible color in light theme, so that I can
   differentiate data series at a glance.

5. As a dashboard user viewing charts, I want each chart series to have
   a distinct, perceptible color in dark theme, so that data
   differentiation works regardless of theme.

6. As a dashboard user, I want input field borders to be clearly visible
   in light theme, so that I can identify where to type.

7. As a dashboard user, I want section dividers and borders to be
   perceptible in light theme, so that the layout structure is
   understandable without effort.

8. As a dashboard maintainer, I want the light theme's sidebar accent
   color to match the dark theme's violet, so that the brand identity
   is consistent across themes.

9. As a dashboard maintainer, I want the focus ring color to be a
   chromatic accent (violet) rather than gray, so that it is
   perceptually distinct from the neutral background in both themes.

10. As a dashboard maintainer, I want the design system documentation
    to accurately describe the color format and WCAG compliance status,
    so that future contributors are not misled.

11. As a dashboard maintainer, I want an automated test that verifies
    WCAG AA contrast ratios for key token pairs, so that regressions
    are caught before they ship.

12. As a dashboard maintainer, I want the project glossary to define
    the color-system terms used in the ADR and documentation, so that
    future discussions about the palette have precise vocabulary.

13. As a dashboard user with low vision, I want secondary text to meet
    WCAG 2.2 AA (4.5:1) contrast, so that I can use the dashboard
    without assistive magnification.

14. As a dashboard user with low vision, I want UI component boundaries
    (inputs, focus indicators) to meet WCAG 2.2 AA (3:1) contrast, so
    that I can perceive interactive elements.

15. As a dashboard user, I want the accent color to not conflict with
    the existing traffic-light status colors (green/red/amber badges),
    so that the information hierarchy remains clear.

16. As a dashboard maintainer, I want the contrast test to parse the
    actual CSS source file, so that it catches token changes at the
    source level rather than requiring a rendered DOM.

17. As a dashboard maintainer, I want the ADR to record why a chromatic
    accent was chosen over darkening-only, so that a future contributor
    understands the structural reasoning.

## Implementation Decisions

### Token changes (light theme `:root`)

The following CSS custom properties in `dashboard/src/index.css` will be
changed. All values are HSL (hue saturation lightness), matching the
existing format.

- `--muted-foreground`: darkened from `0 0% 55.6%` to `0 0% 44%`
  (3.0:1 → 4.95:1 on white, passes 1.4.3 text).

- `--input`: darkened from `0 0% 92.2%` to `0 0% 58%`
  (1.2:1 → 3.03:1 on white, passes 1.4.11 functional UI).

- `--border`: darkened from `0 0% 92.2%` to `0 0% 85%`
  (1.2:1 → 1.41:1 on white). Decorative border — WCAG 1.4.11 exempts
  purely decorative boundaries. Kept light to preserve the
  "restrained, near-neutral" visual identity while remaining perceptible.

- `--ring`: changed from `0 0% 70.8%` (gray, 2.1:1) to `263 70% 50%`
  (violet, 7.23:1 on white). Chromatic accent for focus visibility.

- `--chart-1` through `--chart-5`: replaced the grayscale steps with a
  five-hue palette, each ≥3:1 on white:
  - `--chart-1: 263 70% 50%` (violet, 7.23:1)
  - `--chart-2: 200 70% 45%` (cyan-blue, 3.67:1)
  - `--chart-3: 30 80% 45%` (amber, 3.43:1)
  - `--chart-4: 340 70% 48%` (rose, 5.11:1)
  - `--chart-5: 160 60% 38%` (teal-green, 3.48:1)

- `--sidebar-primary`: changed from `0 0% 20.5%` (gray) to `263 70% 50%`
  (violet). Aligns light theme with the dark theme's existing
  `--sidebar-primary: 263 70% 65%`.

- `--sidebar-ring`: changed from `0 0% 70.8%` to `263 70% 50%`
  (violet, matching `--ring`).

### Token changes (dark theme `.dark`)

- `--chart-1` through `--chart-5`: replaced the grayscale steps with the
  same five-hue palette at lightness values tuned for the dark
  background (each ≥3:1 on `0 0% 14.5%`):
  - `--chart-1: 263 70% 65%` (violet, 3.92:1)
  - `--chart-2: 200 70% 65%` (cyan, 7.16:1)
  - `--chart-3: 30 80% 60%` (amber, 6.70:1)
  - `--chart-4: 340 70% 65%` (rose, 4.85:1)
  - `--chart-5: 160 60% 55%` (teal-green, 7.97:1)

- `--ring`: changed from `0 0% 55.6%` (gray) to `263 70% 65%`
  (violet, 3.92:1).

- `--sidebar-ring`: changed from `0 0% 55.6%` to `263 70% 65%`
  (violet, matching `--ring`).

- `--sidebar-primary`: already violet (`263 70% 65%`) — unchanged.

### Tokens unchanged

All other tokens in both `:root` and `.dark` remain unchanged. They
already pass WCAG AA or are surface/background tokens where contrast
against their paired foreground is already sufficient, except dark
`--input` (`0 0% 100% / 15%`, ~1.6:1) which is a known pre-existing gap
out of scope for this revamp.

### Accent hue choice: violet (263°)

The violet hue was chosen because: (a) the dark theme already committed
to violet for `--sidebar-primary`, providing brand consistency; (b) violet
at the chosen lightness values achieves ≥3:1 on white and on the dark
background; (c) violet does not conflict with the existing traffic-light
status colors (green success, red destructive, amber warning) already
used in the badge system; (d) violet is perceptually distinct from neutral
grays without being as generic as blue.

### Documentation updates

- `dashboard/DESIGN.md`: correct the false claim that tokens are "OKLCH"
  to "HSL". Correct the false claim that all token pairs "meet WCAG AA
  (4.5:1)" to reflect the actual compliance after the revamp. Add a note
  about the chromatic accent strategy for ring and chart colors.

- `CONTEXT.md`: add three glossary terms:
  - **Accent Hue**: the violet (HSL 263°) used for focus rings, chart
    series, and sidebar-primary across both themes.
  - **Functional Border**: a border that delimits an interactive
    element (e.g. input fields) and must meet WCAG 1.4.11 (3:1).
    Distinct from decorative borders which are exempt.
  - **Chart Palette**: the five-hue sequence (violet, cyan, amber, rose,
    teal) used for data visualization, replacing the prior grayscale
    steps.

### ADR

A new ADR `docs/adr/0010-light-theme-contrast-revamp.md` will document:
- The problem (light-theme tokens failing WCAG AA)
- The alternatives considered (darken-only, baseColor switch,
  darken + chromatic accent)
- The decision (darken + chromatic accent)
- The rationale (structural inadequacy of gray for focus and charts;
  brand consistency with existing dark-theme violet; baseColor switch
  debunked as perceptual trick that doesn't change contrast ratios)

### WCAG target

WCAG 2.2 Level AA. Specifically:
- 1.4.3 Contrast (Minimum): 4.5:1 for normal text, 3:1 for large text.
- 1.4.11 Non-text Contrast: 3:1 for UI component boundaries and
  graphical objects.
- 2.4.7 Focus Visible: focus indicators must be visible (evaluated via
  1.4.11's 3:1 threshold).

## Testing Decisions

### What makes a good test here

The test should verify that the CSS custom properties defined in
`index.css` produce contrast ratios that meet WCAG 2.2 AA. It should
parse the actual CSS source file — not a rendered DOM — so that
regressions are caught at the source level. The test should compute
real WCAG contrast ratios using the standard luminance formula, not
approximate via lightness comparisons.

### Test seam

Extend the existing `dashboard/src/__tests__/app-a11y.test.tsx` file
with new test cases that:
1. Read and parse `dashboard/src/index.css` to extract the `:root` and
   `.dark` CSS variable definitions.
2. For each key token pair (muted-foreground/background, ring/background,
   input/background, chart-1 through chart-5/background,
   sidebar-primary/background, sidebar-ring/background), compute the
   WCAG contrast ratio using the sRGB relative luminance formula.
3. Assert text tokens meet 4.5:1 and UI/graphical tokens meet 3:1.

This extends the existing accessibility test file rather than creating a
new one, keeping the testing surface consolidated.

### Modules tested

- `dashboard/src/index.css` (the token definitions)

### Prior art

- `dashboard/src/__tests__/app-a11y.test.tsx` — existing a11y structure
  tests (headings, landmarks, skip links). The contrast assertions
  extend this file's accessibility scope.
- `dashboard/src/__tests__/config-validation.test.ts` — tests source
  content by importing and validating values, a similar pattern to
  parsing CSS source.

## Out of Scope

- Switching the `baseColor` in `components.json` from `neutral` to
  `zinc`/`slate`/`stone`. Research confirmed this does not change
  contrast ratios — it only shifts hue. Not a contrast fix.

- Migrating from HSL to OKLCH color format. The existing codebase uses
  HSL throughout `index.css`. A format migration is a separate concern
  from the contrast fix.

- Redesigning the dashboard's visual layout, component structure, or
  spacing. This spec changes CSS custom property values only.

- Changing the `--primary`, `--foreground`, `--background`, `--card`,
  `--popover`, `--secondary`, `--muted`, `--accent`, `--destructive`,
  or their `-foreground` counterparts. These already pass WCAG AA and
  are not part of the reported problem.

- Adding new shadcn/ui components or modifying existing component
  markup. The fix is token-level only.

- Implementing a theme picker beyond the existing system/light/dark
  toggle.

- Changing the badge color system (`badgeSuccess`, `badgeWarning`,
  `badgeInfo`). These traffic-light colors are intentionally separate
  from the neutral/chromatic-accent palette and are not affected.

## Further Notes

### Contrast ratio verification

All proposed token values were verified computationally against WCAG
2.2 luminance formulas. The verification script converted HSL → sRGB →
relative luminance and computed `(L_lighter + 0.05) / (L_darker + 0.05)`
for each token pair against the theme background. Every functional token
meets its AA threshold. The `--border` token at `0 0% 85%` achieves only
1.41:1 but qualifies for the WCAG 1.4.11 decorative-border exemption.

### Why not darken-only (Path A)

Darkening the failing tokens alone would fix text legibility
(`--muted-foreground`) and functional borders (`--input`). However, it
cannot solve the structural problem with focus rings (a gray ring on a
gray background can never be perceptually distinct enough regardless of
lightness) or with charts (five grayscale steps are visually
indistinguishable as data series). The chromatic accent approach
addresses both the contrast problem and the data-viz usability problem
in a single change.

### Why not switch baseColor (Path B)

Research via the shadcn/ui registry confirmed that `muted-foreground`
stays at ~55% lightness and `ring` stays at ~70% lightness across all
neutral-ish baseColors (neutral, zinc, stone, slate, gray). The hue
changes; the lightness — and therefore the contrast ratio — does not.
A baseColor swap is a perceptual trick, not a contrast fix.

### Consistency with existing design philosophy

`dashboard/DESIGN.md` states: "colored status is the cleaner information
hierarchy for a capture tool." Extending chromatic color from status
badges to focus rings and chart series is consistent with this
philosophy — color carries functional meaning (focus state, data series
identity), while the base palette remains restrained and neutral.
