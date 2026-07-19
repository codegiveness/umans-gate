# 01 — Raw samples: storage, coalescing writer, API, tab shell

**What to build:** The thinnest vertical slice proving the whole stack works. A new `usage_samples` SQLite table is created at startup (gated on `usage_history_enabled`). The history module subscribes to `UmansUsageClient.onChange()` and writes coalesced sample rows (byte-identical to last row → skip write). A new `GET /dashboard/api/usage/samples?date=YYYY-MM-DD` endpoint returns raw samples for a UTC day. A new "Usage" tab appears in the dashboard, showing a raw list of today's samples. Open the tab → watch samples appear live as the proxy polls `/v1/usage`. This slice proves the storage layer, the onChange hook, the API route pattern, the tab registration, and the test seam all work end-to-end before any of them are extended.

**Blocked by:** None — can start immediately

**Status:** ready-for-agent

- [ ] `usage_samples` table created at startup via `CREATE TABLE IF NOT EXISTS`, gated on `usage_history_enabled` (default true). Indexed on `fetched_at`.
- [ ] New `src/usage-history/` module owns the table + writer. Subscribes to `UmansUsageClient.onChange()`. Does NOT touch stamp logic, capture storage, or gate behavior (SRP).
- [ ] Coalescing rule: compare new snapshot's ambient fields byte-for-byte against last-written sample; if identical, skip write; if any field differs, write the row. First-ever sample always writes.
- [ ] `GET /dashboard/api/usage/samples?date=YYYY-MM-DD` returns raw samples for that UTC day (following the existing `/dashboard/api/economics/*` route pattern). Dashboard-token auth inherited from existing viewer middleware.
- [ ] New "Usage" tab registered in `dashboard/src/App.tsx` alongside Captures, Config, Economics, Models. Tab shows a raw list (timestamp + key ambient fields) of today's samples, fetched from the new endpoint.
- [ ] New config knob `usage_history_enabled` (default true, hot-reloadable) added to `RawConfig` + `ProxyConfig` + validation + defaults + loader + reload allowlist. JSON `snake_case` + env `UPPER_SNAKE_CASE` equivalents.
- [ ] Integration test (pattern: `test/usage-dashboard.test.ts`) — spawn proxy + mock upstream serving scripted `/v1/usage` responses; let poll cycle fire; fetch `/dashboard/api/usage/samples?date=today`; assert rows exist with correct ambient fields; drive identical snapshots → assert only one sample row written (coalesce verified).
- [ ] Dashboard component test (pattern: `economics-tab.tsx` + its vitest/jsdom test) — mock fetch, assert the tab renders and displays sample rows.
- [ ] `bun run typecheck` passes; `bun run lint` introduces no new warnings; no `as any` / `@ts-ignore` / `@ts-expect-error`.
