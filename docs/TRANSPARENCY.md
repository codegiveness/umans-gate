# Transparency report: every endpoint umans-gate contacts

> **Applies to:** umans-gate v0.6.0 · **Last updated:** 2026-07-31

umans-gate needs your Umans API key to unlock `/v1/usage` polling,
concurrency sizing, rate-limit validation, and vision handoff. This
document exists so you can verify, line by line, exactly where that key
goes, what else the app contacts, and what it never does.

**Nothing here is aspirational.** Every entry is backed by a source-file
reference you can audit yourself. This document is not the product of a
formal security audit. If you find behavior that contradicts this
document, report it via [SECURITY.md](../SECURITY.md).

---

## TL;DR

- The proxy listens on `127.0.0.1:1945` **only**. It is not reachable
  from your network unless you explicitly tunnel it.
- Your `UMANS_API_KEY` is sent to exactly one host:
  `api.code.umans.ai`, on two paths, as a `Bearer` token. Nowhere else.
- The only other outbound traffic is an explicit self-update command
  (`umans-gate update`) you run by hand — it hits npm and GitHub and
  never carries your API key.
- No analytics. No telemetry. No error reporting. No phone-home. No
  third-party CDNs, fonts, or trackers in the dashboard.

---

## 1. Upstream LLM API — `api.code.umans.ai`

The proxy forwards all LLM traffic to one hardcoded upstream. This
target is **not user-configurable** — see
[`src/config/constants.ts`](../src/config/constants.ts):

```ts
export const UPSTREAM_TARGET = "https://api.code.umans.ai";
```

The host can be overridden with the `TARGET` env var (used by the test
suite to point at a local echo upstream), but in normal operation every
outbound LLM call lands on `api.code.umans.ai`.

| Path | Method | Auth | Purpose | Source | Off-switch |
|---|---|---|---|---|---|
| `/v1/messages` | POST | passthrough client key | Anthropic chat completions | `src/proxy.ts` | none (core proxy path) |
| `/v1/chat/completions` | POST | passthrough client key | OpenAI-compatible chat + vision handoff | `src/proxy.ts`, `src/vision/sink.ts` | `vision_strategy: never` disables the vision handoff branch |
| `/v1/models` | GET | none | Connection warmer pings + model list | `src/config/constants.ts` (`WARMER_PATH`), `src/models.ts` | `warmer_enabled: false` stops warmer pings |
| `/v1/models/info` | GET | none | Public model catalog (no auth sent) | `src/models/fetch-info.ts` | none (fetched on demand when the Models tab is opened) |
| `/v1/usage` | GET | `Authorization: Bearer <UMANS_API_KEY>` | Usage polling for concurrency/rate sizing | `src/usage/fetch-usage.ts` | unset `UMANS_API_KEY` disables polling |
| `/v1/status` | GET | `Authorization: Bearer <UMANS_API_KEY>` | Upstream status checks | `src/status-client.ts` | unset `UMANS_API_KEY` disables status checks |

### What "passthrough client key" means

For `/v1/messages` and `/v1/chat/completions`, the proxy forwards
whatever `Authorization` (or `x-api-key`) header your harness sent. It
does **not** inject `UMANS_API_KEY` into those calls. `UMANS_API_KEY`
is used solely for the `/v1/usage` and `/v1/status` side channels
listed above.

### Where your `UMANS_API_KEY` actually goes

Only two places, both on `api.code.umans.ai`:

```ts
// src/usage/fetch-usage.ts
headers: { authorization: `Bearer ${apiKey}` }
// src/status-client.ts — same pattern
```

The key is **never** sent to:

- npm registry
- GitHub API
- Any analytics, telemetry, or error-reporting service
- Query strings or URL paths (it travels only in the `Authorization` header)
- Error responses (4xx/5xx bodies are not enriched with the key)
- Anywhere other than `api.code.umans.ai`

### How the key is stored

- **Env var** (`UMANS_API_KEY`): lives in your shell or service
  EnvironmentFile. On systemd the EnvironmentFile is `chmod 600` (see
  [`src/service/systemd.ts`](../src/service/systemd.ts)); on macOS the
  launchd plist file gets the same `chmod 600` (see
  [`src/service/launchd.ts`](../src/service/launchd.ts)).
- **Config file** (`~/.config/umans-gate/config.json` on Linux/macOS,
  `%APPDATA%/umans-gate/config.json` on Windows): user-owned, never
  transmitted off-machine except to `api.code.umans.ai` as above.
- **Dashboard Config tab**: writes to the same config file; never
  logged, never broadcast over WebSocket (the value is masked in API
  responses — see `src/viewer.ts`).

The key is never written to the SQLite capture database, never included
in WebSocket broadcasts, and never appears in log output.

---

## 2. Self-update — only when you run `umans-gate update`

The updater runs **only** when you explicitly invoke
`umans-gate update` or click the dashboard's update button. It is not
background telemetry. It contacts:

| Host | Path | Auth | Purpose | Source |
|---|---|---|---|---|
| `registry.npmjs.org` | `/umans-gate/latest` | none | Check latest published version | `src/updater.ts` (`NPM_REGISTRY`) |
| `api.github.com` | `/repos/codegiveness/umans-gate/releases/latest` | none (rate-limited public API) | Fetch release metadata for standalone-binary updates | `src/updater.ts` (`GITHUB_API`) |
| `github.com` | `/codegiveness/umans-gate/releases/download/<tag>/<asset>` | none | Download binary asset + `SHA256SUMS` for verification | `src/updater.ts` |

The updater **never** sends your API key, your config, or any capture
data. It sends only a `User-Agent: umans-gate-updater` header to
GitHub. Downloaded binaries are SHA-256 verified against the published
`SHA256SUMS` asset before the existing binary is replaced.

---

## 3. Dashboard — no external runtime dependencies

The dashboard is a Vite-bundled SPA. At runtime in your browser it loads
**only** assets served from the proxy itself (`http://127.0.0.1:1945`).

| Resource | Origin | Loaded at |
|---|---|---|
| JS / CSS bundles | proxy (Vite build output) | runtime, from `127.0.0.1` |
| Favicons | proxy (`/dashboard/favicon*.ico`, `*.png`) | runtime, from `127.0.0.1` |
| Tailwind CSS, tw-animate-css, shadcn/ui | bundled into the JS/CSS at build time | build time only |

**No Google Fonts. No `fonts.googleapis.com`. No `gstatic`. No unpkg.
No jsdelivr. No CDN.** The only `@import` statements in
`dashboard/src/index.css` resolve to npm packages that Vite inlines at
build time.

The only external **links** (user-clickable, never auto-fetched by the
app) are:

- `https://app.umans.ai` — the "Get API key" link in the API key gate
  (`dashboard/src/components/api-key-gate.tsx`). Opens in a new tab
  only when you click it.
- `https://ui.shadcn.com/schema.json` — referenced in
  `dashboard/components.json` as a JSON schema hint for the shadcn CLI.
  Used at component-generation time by the maintainer, never fetched by
  the running app.

---

## 4. Listen address — loopback only

The proxy binds to `127.0.0.1` and nothing else:

```ts
// src/config/loader.ts
const host = "127.0.0.1";
// src/index.ts
const config: ProxyConfig = { ...envConfig, ...options.config, host: "127.0.0.1" };
```

`host` is **not** a config field and **cannot** be overridden via
config.json or env. The proxy is unreachable from your LAN, from other
containers, or from the internet unless you set up an SSH tunnel or
reverse proxy yourself.

---

## 5. What umans-gate never does

- **No analytics or telemetry.** No Sentry, PostHog, Mixpanel, Google
  Analytics, Plausible, or any other tracker. Verify yourself:

  ```bash
  rg -i 'sentry|posthog|mixpanel|amplitude|segment|plausible|gtag|googletagmanager' src/ dashboard/src/
  # expected: no matches
  ```
- **No error reporting.** Exceptions are logged to stdout/stderr on the
  machine running the proxy. They do not leave the machine.
- **No phone-home / version check on startup.** Version checks happen
  only via the explicit `umans-gate update` command or the dashboard
  "check for updates" button.
- **No third-party CDNs at runtime.** All dashboard assets are
  bundled and served from `127.0.0.1`.
- **No external fonts.** The dashboard uses system font stacks via
  Tailwind; no web fonts are fetched.
- **No capture data leaves your machine.** Captures are stored in
  `./umans-gate.db` (SQLite, WAL mode) on the proxy host. They are
  served only to your browser over loopback. They are never uploaded
  anywhere.
- **No request body inspection by the maintainer.** The maintainer
  cannot see your traffic. The proxy is open source; audit the code and
  run your own build if you want to be certain.

---

## 6. Documentation links (not runtime)

These URLs appear in source comments and docs only. The running app
never fetches them.

- `https://platform.claude.com/docs/...` — Anthropic API docs, cited in
  `src/usage/extract.ts` comments.
- `https://developers.openai.com/api/docs/...` — OpenAI API docs, same
  file.
- `https://github.com/umans-ai/umans-open-stack` — referenced in
  `docs/what-work-with-umans.md` for playbook alignment.
- `https://github.com/codegiveness/umans-gate` — the source repo,
  linked from README and docs.

---

## 7. How to verify this yourself

1. **Grep for every URL in the source tree:**
   ```bash
   grep -rEn 'https?://[a-zA-Z0-9.-]+' src/ dashboard/src/
   ```
   Every hit should appear in the tables above.

2. **Watch outbound traffic while the proxy runs:**
   ```bash
   # replace eth0 with your interface
   sudo tcpdump -i any -nn 'dst port 443 or dst port 80' &
   bun src/cli.ts
   # make a test request, then kill tcpdump
   ```
   You should see only `api.code.umans.ai` traffic. Run
   `umans-gate update` in a second window and you'll also see
   `registry.npmjs.org` / `api.github.com` / `github.com`.

3. **Inspect the SQLite database for your API key:**
   ```bash
   sqlite3 umans-gate.db ".dump" | grep -i 'your-key-prefix'
   ```
   Zero hits expected — the key is never persisted to the capture DB.

4. **Run the existing transparency test:**
   ```bash
   bun test test/e2e/transparency.test.ts
   ```
   It asserts that with stamping disabled, request bodies and response
   headers pass through unchanged.

---

## 8. Reporting concerns

If you find behavior that contradicts this document, treat it as a
security issue and follow [SECURITY.md](../SECURITY.md). The project
commits to a 48-hour acknowledgment SLA on confirmed reports.

## See also

- [proxy-modifications.md](proxy-modifications.md) — every mutation the
  proxy applies to request/response traffic.
- [ARCHITECTURE.md](ARCHITECTURE.md) — system design and data flow.
- [SECURITY.md](../SECURITY.md) — vulnerability reporting and practices.
- [OPERATIONS.md](OPERATIONS.md) — day-to-day operations including
  config file locations and permissions.
