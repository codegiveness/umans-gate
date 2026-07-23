# 01 — Light + dark theme CSS token revamp with contrast tests

**What to build:** The dashboard's light theme is currently illegible — muted text fails WCAG 2.2 AA contrast (3.0:1 on white, needs 4.5:1), focus rings are invisible (2.1:1, needs 3:1), chart colors vanish on white (1.3:1), and input borders are imperceptible (1.2:1). Dark theme works for text but all five chart colors are grayscale, making data series indistinguishable. This ticket delivers the fix: revamp all failing CSS custom properties in `index.css` (both `:root` and `.dark`) to WCAG-AA-compliant values, then extend the existing accessibility test with real contrast-ratio assertions that parse the CSS source and verify every key token pair against its threshold. After this ticket, opening the dashboard in light theme shows legible text, visible focus rings, and distinct chart colors — and an automated test prevents regressions.

**Blocked by:** None — can start immediately.

**Status:** ready-for-agent

- [ ] In `:root` (light theme), change `--muted-foreground` from `0 0% 55.6%` to `0 0% 44%` (achieves 4.95:1 on white, passes WCAG 1.4.3 text)
- [ ] In `:root`, change `--input` from `0 0% 92.2%` to `0 0% 58%` (achieves 3.03:1 on white, passes WCAG 1.4.11 functional UI)
- [ ] In `:root`, change `--border` from `0 0% 92.2%` to `0 0% 85%` (decorative — WCAG 1.4.11 exempts purely decorative borders; kept light to preserve the restrained neutral identity while remaining perceptible)
- [ ] In `:root`, change `--ring` from `0 0% 70.8%` to `263 70% 50%` (violet accent, achieves 7.23:1 on white, passes WCAG 2.4.7 focus visibility)
- [ ] In `:root`, replace `--chart-1` through `--chart-5` grayscale values with a five-hue palette: `263 70% 50%` (violet), `200 70% 45%` (cyan), `30 80% 45%` (amber), `340 70% 48%` (rose), `160 60% 38%` (teal) — each achieves ≥3:1 on white, passes WCAG 1.4.11 graphical objects
- [ ] In `:root`, change `--sidebar-primary` from `0 0% 20.5%` to `263 70% 50%` (violet, aligns with dark theme's existing violet sidebar-primary)
- [ ] In `:root`, change `--sidebar-ring` from `0 0% 70.8%` to `263 70% 50%` (violet, matches `--ring`)
- [ ] In `.dark`, replace `--chart-1` through `--chart-5` grayscale values with the same five-hue palette at dark-tuned lightness: `263 70% 65%`, `200 70% 65%`, `30 80% 60%`, `340 70% 65%`, `160 60% 55%` — each achieves ≥3:1 on the dark background
- [ ] In `.dark`, change `--ring` from `0 0% 55.6%` to `263 70% 65%` (violet, achieves 3.92:1 on dark background)
- [ ] In `.dark`, change `--sidebar-ring` from `0 0% 55.6%` to `263 70% 65%` (violet, matches `--ring`)
- [ ] No other CSS custom properties are changed — all passing tokens (primary, foreground, background, card, popover, secondary, muted, accent, destructive, sidebar, sidebar-foreground, sidebar-accent, etc.) remain untouched
- [ ] Extend `app-a11y.test.tsx` with test cases that parse `index.css`, extract `:root` and `.dark` variable values, compute WCAG contrast ratios using the sRGB relative luminance formula `(L_lighter + 0.05) / (L_darker + 0.05)`, and assert: text tokens (muted-foreground) ≥4.5:1, UI/graphical tokens (ring, input, chart-1..5, sidebar-primary, sidebar-ring) ≥3:1, for both themes against their respective backgrounds
- [ ] `bun run typecheck` passes
- [ ] `bun run lint` passes with no new warnings
- [ ] `bun run test:dashboard` passes (including the new contrast assertions)
