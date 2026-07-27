# Product

> **Applies to:** umans-gate v0.4.5 · **Last updated:** 2026-07-27

## What umans-gate Does

umans-gate is a personal-use LLM capture proxy that intercepts Anthropic and OpenAI-compatible traffic, stamps `ttl` onto `cache_control` ephemeral blocks, and inspects every request/response in a live React dashboard without client code changes.

The project has three core responsibilities:

1. **Intercept** Anthropic and OpenAI-compatible LLM API traffic, then store
   every request/response pair in a SQLite ring buffer (default 200 captures).
2. **Stamp** `ttl` onto Anthropic `cache_control` ephemeral blocks before
   forwarding upstream. The stamped body is forwarded AND captured — the
   inspector shows exactly what went to the API.
3. **Inspect** via a live React + shadcn/ui dashboard with WebSocket updates,
   SSE rendering, performance telemetry, and a config tab with hot-reload.

Run `npx umans-gate`, point any LLM harness at `http://localhost:1945`, and
within seconds see bodies, headers, stream events, latency, and TTL effects
without modifying client code.

## What Is the Design Personality?

**Precise. Confident. Engineered.**

The dashboard should feel as precise as the proxy: tight spacing,
considered typography, and every pixel earning its place. The target feel
is Linear or the Vercel dashboard — opinionated, modern, and never
decorative. The tool reflects the craft of the people who built it.

When a developer opens the inspector during a debugging session, they
should feel **"this thing is on my side"** — fast, accurate, uncluttered,
and showing what they need without making them hunt.

## What Are the Anti-references?

- **Terminal-ugly / 90s dev tool aesthetic.** Monospace-everything, no
  styling, Win32-form panels, the look of a tool that apologizes for being
  a tool. The dashboard should feel modern and considered, not retro or
  unstylish. Modern typography, real spacing, real hierarchy — just not
  decorative.
- **Generic SaaS dashboard.** Hero metric cards, gradient accents, and
  marketing-page aesthetics have no place in a working tool. This is
  called out so the team keeps it avoided.

## What Are the Design Principles?

1. **Practice what you preach.** The proxy stamps precise TTLs onto cache
   blocks; the dashboard itself must be precise and considered. The tool's
   craft is visible in its own interface.

2. **Show, don't tell.** The inspector shows exactly what went to the API
   (stamped body = captured body). The UI shows real captured data, not
   summary decoration. Every number on screen traces to a real capture.

3. **Expert confidence.** The user is a developer who knows LLM APIs. Do
   not over-explain, do not pad with onboarding hand-holding, do not
   decorate to make things "approachable." Trust the user.

4. **Density without noise.** High information density is correct for a
   capture inspector, but every pixel earns its place. Tight rhythm, real
   hierarchy, no ornament between the user and the data.

5. **The tool disappears.** When debugging, the inspector should get out
   of the way. It is fast, keyboard-first, and keeps latency minimal between
   "something happened on the wire" and "I can see it in the dashboard."

## Accessibility & Inclusion

- **WCAG AA is the target** — 4.5:1 contrast for small text, 3:1 for large
  text, across both light and dark themes. Existing semantic token pairs
  (`success`, `warning`, `info`, `sse`, `destructive`) are already tuned
  to pass AA in both themes; this is the floor, not a goal to relax.
- **Keyboard-first.** All interactive elements are reachable and operable by
  keyboard; focus rings are never removed without a replacement. The capture
  list is a `role="listbox"` with full arrow-key navigation.
- **Reduced motion.** Functional motion (for example the WebSocket "down"
  `animate-pulse`) must respect `prefers-reduced-motion: reduce`. No
  decorative motion that gates content visibility.
- No additional accommodations are in scope beyond the contract already
  documented in `dashboard/DESIGN.md`.
