# 07 — Polish: WS live updates, config hot-reload verification, CONTEXT.md glossary

**What to build:** The final polish slice that makes the Usage tab feel complete. The tab subscribes to a new WebSocket message type (new sample written / new event written → recent-day view refreshes without manual reload). All three config knobs (`usage_history_enabled`, `usage_raw_retention_days`, `usage_gap_threshold_minutes`) verified as hot-reloadable via the existing reload pattern — change them in the Config tab → they apply without restart. Six glossary terms added to `CONTEXT.md` per the domain-modeling skill: priority tuple, service_mode tuple, Dimension A (accumulated active hours), Dimension B (UTC clock span), day_completeness, cacheHitRate (history variant — with the distinction from existing `cached_pct` made explicit). Open the Usage tab → it stays live without refresh; change a config knob → it applies without restart; `CONTEXT.md` documents the new domain language.

**Blocked by:** 05 — Timeline recent (UI exists to receive WS updates), 06 — Timeline old (full feature exists; this is polish on top)

**Status:** ready-for-agent

- [ ] New WS message type added to the `WsMessage` discriminated union in `src/types.ts` + `dashboard/src/types.ts`. Shape: `{ type: "usage-sample"; ... }` and/or `{ type: "usage-event"; ... }` — exact payload is an implementation decision, but it must carry enough for the dashboard to know whether to refresh samples, events, or both.
- [ ] `src/ws.ts` broadcasts the new message type when the history module writes a new sample or event. History module calls the broadcaster (injected dependency, not imported concretely — DIP).
- [ ] Usage tab subscribes to the new WS message type. On receipt, refetches the relevant API endpoint (samples or events) for the currently-viewed day. No full-page reload; no refetch of unrelated data.
- [ ] All three config knobs verified hot-reloadable: change via Config tab → `POST /dashboard/api/config/reload` → knob applies without restart. Verified via integration test that changes `usage_raw_retention_days` and asserts the downsampling job picks up the new value on its next run.
- [ ] `CONTEXT.md` glossary entries added per the domain-modeling skill format (matching the existing entries' structure):
  - **Priority tuple** — composite priority state; one event per tuple change, not per field
  - **Service_mode tuple** — `{current, resetsAt}`; one event per tuple change
  - **Dimension A (accumulated active hours)** — sum of minutes where activity was actually happening; bot-detection theory "humans work ≤8h"
  - **Dimension B (UTC clock span)** — `last_activity_utc − first_activity_utc` within a UTC day; bot-detection theory "umans simplistically computes span"
  - **day_completeness** — the completeness flag: full/partial_start/partial_end/partial_both/missing/incomplete_window
  - **cacheHitRate (history)** — `tokensCached / (tokensIn + tokensOut + tokensCached)`, 0–1. MUST note distinction from existing `cached_pct` (which uses `total_input_tokens` as denominator and is a per-capture metric, not a `/v1/usage`-derived metric)
- [ ] Integration test — open Usage tab via dashboard test harness; drive a new sample via mock upstream; assert WS message received and tab refetches without manual reload.
- [ ] Integration test — change `usage_raw_retention_days` via Config tab; trigger downsampling; assert new retention value applied.
- [ ] `bun run typecheck` passes; `bun run lint` clean; no type suppressions.
- [ ] Consistency checklist from `AGENTS.md`: `bun run typecheck` + `bun test` + `bun run build` all pass.
