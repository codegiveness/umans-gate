# Product

> **Applies to:** umans-gate v0.3.25 · **Last updated:** 2026-07-26

## Project Goals

umans-gate is a personal-use LLM capture proxy. It exists to solve a
specific problem: seeing exactly what goes between an LLM harness and the
upstream API, in real time, without modifying client code.

The project has three core responsibilities:

1. **Intercept** LLM API traffic (Anthropic + OpenAI-compatible) and store
   every request/response pair in SQLite with a ring buffer.
2. **Stamp** `ttl` onto Anthropic `cache_control` ephemeral blocks
   before forwarding upstream, so ephemeral cache entries get a default TTL
   without client changes. The stamped body is what is forwarded AND what is
   captured — the inspector shows exactly what went to the API.
3. **Inspect** via a live React + shadcn/ui dashboard with WebSocket updates,
   SSE rendering, performance telemetry, and a config tab with hot-reload.

Success looks like: run `npx umans-gate`, point any LLM harness at the
proxy, and within seconds see exactly what is on the wire — bodies, headers,
stream events, latency, and the effect of TTL stamping — without modifying
client code. Setup is a single command; the proxy runs unattended.

## Design Personality

**Precise. Confident. Engineered.**

Three words that should describe the dashboard the way they describe the
proxy itself: tight spacing, considered typography, every pixel earning its
place. The feel is Linear or the Vercel dashboard — opinionated, modern,
but never decorative. The tool reflects the craft of the people who built
it. It does not apologize for being a developer tool, nor does it dress up
as something friendlier than it is.

Emotional goal: when a developer opens the inspector during a debugging
session, they should feel **"this thing is on my side"** — fast, accurate,
uncluttered, showing them what they need without making them hunt.

## Anti-references

- **Terminal-ugly / 90s dev tool aesthetic.** Monospace-everything, no
  styling, Win32-form panels, the look of a tool that apologizes for being
  a tool. The dashboard should feel modern and considered, not retro or
  unstylish. Modern typography, real spacing, real hierarchy — just not
  decorative.
- Implicitly avoided (and called out so it stays avoided): the opposite
  extreme of generic SaaS dashboards — hero metric cards, gradient accents,
  marketing-page aesthetics in what is a working tool.

## Design Principles

1. **Practice what you preach.** The proxy stamps precise TTLs onto
   cache blocks; the dashboard should itself be precise and considered.
   The tool's craft is visible in its own interface.

2. **Show, don't tell.** The inspector shows exactly what went to the API
   (stamped body = captured body). The UI shows real captured data, not
   summary decoration. No hero metrics for their own sake; every number on
   screen traces to a real capture.

3. **Expert confidence.** The user is a developer who knows LLM APIs. Do
   not over-explain, do not pad with onboarding hand-holding, do not
   decorate to make things "approachable." Trust the user.

4. **Density without noise.** High information density is correct for a
   capture inspector — but every pixel earns its place. Tight rhythm,
   real hierarchy, no ornament between the user and the data.

5. **The tool disappears.** When you are debugging, the inspector should
   get out of the way. Fast, keyboard-first, minimal latency between
   "something happened on the wire" and "I can see it in the dashboard."

## Accessibility & Inclusion

- **WCAG AA is the target** — 4.5:1 contrast for small text, 3:1 for large
  text, across both light and dark themes. Existing semantic token pairs
  (`success`, `warning`, `info`, `sse`, `destructive`) are already tuned
  to pass AA in both themes; this is the floor, not a goal to relax.
- **Keyboard-first.** All interactive elements are reachable and operable
  by keyboard; focus rings are never removed without a replacement. The
  capture list is a `role="listbox"` with full arrow-key navigation.
- **Reduced motion.** Functional motion (e.g. the WebSocket "down"
  `animate-pulse`) must respect `prefers-reduced-motion: reduce`. No
  decorative motion that gates content visibility.
- No additional accommodations are in scope beyond the contract already
  documented in `dashboard/DESIGN.md`.
