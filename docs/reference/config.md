# Config Tab Reference

> **Applies to:** umans-gate v0.6.1 · **Last updated:** 2026-07-31

The Config tab edits proxy settings and triggers live reload or restart.

## Tab

- **Name**: Config
- **Value**: `config`
- **Lazy**: Yes

## Components

| File | Component |
|---|---|
| dashboard/src/components/config-tab.tsx | ConfigTab |
| dashboard/src/components/config-fields.tsx | ConfigFields |

## Data source

- src/config.ts (barrel) re-exports:
  - `loadConfig` at src/config/loader.ts
  - `DEFAULT_CONFIG` at src/config/defaults.ts
  - `saveConfigLocked` at src/config/file.ts:90
  - `resetConfig` at src/config/file.ts:115
  - `validateConfig` at src/config/validation.ts:727
  - `applyReloadToConfig` at src/config/reload.ts

## REST Endpoints

All prefixed `/dashboard/api/`.

| Method | Path | Purpose |
|---|---|---|
| GET | /config | Read config (API key stripped) |
| POST | /config | Save config |
| POST | /config/validate | Validate without saving |
| POST | /config/reload | Hot-reload from disk |
| POST | /config/reset | Reset to defaults + reload |
| POST | /restart | Restart server (needs process manager) |
| POST | /usage/refresh-source | Refresh limits from /v1/usage |

## WebSocket

- Endpoint: `/dashboard/ws`
- `version` message: version info + update check
- Config changes do not broadcast; client refetches after save

## What the Config Tab Does

The Config tab edits proxy settings and applies hot-reloadable fields without a restart. All config fields are hot-reloadable except those marked `restartRequired` (e.g. `port`, `max_captures`, `db_path`, `idle_timeout`, `upstream_protocol`, `queue_max_depth`, `ws_backpressure_limit`, `ws_close_on_backpressure_limit`, `warmer_*`, `usage_refresh_ms`, `umans_api_key`, `dashboard_token`, `models_refresh_ms`, and all `vision_*` tuning fields). The full hot-reloadable set is defined in `src/config/reload.ts` (`RELOAD_FIELDS`); restart-required fields are in `RESTART_REQUIRED_FIELDS` in the same file. Fields marked `restartRequired` require a server restart via `/restart` or a process manager.

Notable hot-reloadable fields: `stamp_claude_code_enabled`,
`stamp_model_rules` (per-model thinking-shape rules table, ADR-0029),
`stamp_reasoning_effort_enabled`, all `concurrency_*` and `breaker_*`
fields, all `request_*` request-cap fields (`request_hard_cap`,
`request_soft_limit`, `request_use_hard_cap`, `never_limit_requests`,
`rate_limit_requests`), all `ttft_*` fields, `experiment_*` toggles,
`capture_body_max_bytes`, `compression_enabled`, `upstream_timeout_ms`,
`performance_sample_count`, `incident_retention_days`, and the
vision intent-aware fields (`vision_intent_strategy`,
`vision_decomposition_*`, `vision_crafting_timeout_ms`,
`vision_adjacent_text_max_chars`, `vision_recent_messages_count`,
`vision_system_prompt_max_chars`).

## Config file

- Linux/macOS: `$XDG_CONFIG_HOME/umans-gate/config.json`
  or `~/.config/umans-gate/config.json`
- Windows: `%APPDATA%/umans-gate/config.json`
- Precedence: env vars > JSON file > built-in defaults
- Existing configs never overwritten on first run

## Related

- Source: src/viewer.ts (route handlers), src/config/* (modules)
- Update flow: `/dashboard/api/version` + `/dashboard/api/update`
