# 02 — Documentation: DESIGN.md correction, CONTEXT.md glossary, ADR 0010

**What to build:** The design system documentation currently makes two false claims about the dashboard's color tokens: it says the format is "OKLCH" (it's actually HSL) and that all token pairs "meet WCAG AA (4.5:1)" (the light theme didn't until ticket 01 shipped). This ticket corrects those claims, adds three precise glossary terms to the project's domain vocabulary, and records the architectural decision as an ADR. After this ticket, a future contributor reading the docs understands the actual color format, the actual compliance status, the vocabulary for discussing the palette, and why a chromatic accent was chosen over darken-only or baseColor switch.

**Blocked by:** 01 — Light + dark theme CSS token revamp with contrast tests

**Status:** ready-for-agent

- [ ] In `dashboard/DESIGN.md`, correct the "OKLCH tokens" claim to "HSL tokens" wherever it appears
- [ ] In `dashboard/DESIGN.md`, correct the WCAG AA compliance claim to accurately reflect the post-revamp state (light theme now passes AA; note which tokens were changed and why)
- [ ] In `dashboard/DESIGN.md`, add a note about the chromatic accent strategy: violet (HSL 263°) is used for focus rings, chart series, and sidebar-primary, extending the existing "colored status is the cleaner information hierarchy" philosophy to functional color (focus, data-viz)
- [ ] In `CONTEXT.md`, add glossary term **Accent Hue**: the violet (HSL 263°) used for focus rings, chart series, and sidebar-primary across both themes; chosen for brand consistency with the dark theme's existing violet sidebar-primary and for perceptual distinctness from the neutral base palette and the traffic-light status colors
- [ ] In `CONTEXT.md`, add glossary term **Functional Border**: a border that delimits an interactive element (e.g. input fields) and must meet WCAG 1.4.11 (3:1); distinct from decorative borders which are exempt from the non-text contrast requirement
- [ ] In `CONTEXT.md`, add glossary term **Chart Palette**: the five-hue sequence (violet, cyan, amber, rose, teal) used for data visualization, replacing the prior grayscale steps that were visually indistinguishable as data series
- [ ] Create `docs/adr/0010-light-theme-contrast-revamp.md` documenting: the problem (light-theme tokens failing WCAG AA across muted-foreground, ring, chart, border, input), the three alternatives considered (darken-only neutrals, switch baseColor from neutral to zinc/slate/stone, darken + chromatic accent), the decision (darken + chromatic accent), and the rationale (structural inadequacy of gray for focus rings and charts; baseColor switch debunked as perceptual trick that doesn't change contrast ratios; brand consistency with existing dark-theme violet; WCAG 2.2 AA as the target level)
- [ ] `bun run typecheck` passes (docs changes should not affect it, but verify no accidental code edits)
- [ ] `bun run lint` passes
