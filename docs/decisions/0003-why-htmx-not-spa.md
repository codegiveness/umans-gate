# 3. Why HTMX, Not a SPA

## Context

The dashboard shows live provider capacity, active models, and request history. We wanted the dashboard to load instantly from the same binary, require no separate build pipeline, and stay maintainable with a small team.

We considered:

- **Single-page application with React/Vue/Svelte**: rich interactivity, but needs a bundler, a separate package.json, and a more complex deployment.
- **Plain server-rendered HTML plus polling**: simple, but polling adds latency and unnecessary traffic.
- **Server-rendered templates plus HTMX**: gives live updates via Server-Sent Events, keeps all rendering on the server, and avoids a JavaScript build step.

## Decision

We will render the dashboard with Askama templates on the server and drive live updates with HTMX and Server-Sent Events (SSE).

## Consequences

- The dashboard is built entirely inside the Rust workspace; there is no `node_modules` or frontend bundler to maintain.
- Askama compiles templates at build time, catching template errors early and avoiding runtime filesystem dependencies in production.
- HTMX with SSE replaces only the changed fragments, so the dashboard feels live without a heavyweight client framework.
- Static assets (htmx.min.js, sse.js) are embedded into the binary with rust-embed, so the dashboard works from a single executable.
- The design trades some client-side customization for operational simplicity, which matches our self-contained binary goal.

## Status: Accepted
