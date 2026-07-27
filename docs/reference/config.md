# Config Tab Reference

> **Applies to:** umans-gate v0.4.7 · **Last updated:** 2026-07-27

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

The Config tab edits proxy settings and applies hot-reloadable fields without a restart. All config fields are hot-reloadable except those marked `restartRequired` (e.g. `port`, `db_path`, `upstream_protocol`, `vision_strategy`, `vision_model`, `warmer_*`, `umans_api_key`, `dashboard_token`). The full hot-reloadable set is defined in `src/config/reload.ts` (`RELOAD_FIELDS`); restart-required fields are in `RESTART_REQUIRED_FIELDS` in the same file. Fields marked `restartRequired` require a server restart via `/restart` or a process manager.

## Config file

- Linux/macOS: `$XDG_CONFIG_HOME/umans-gate/config.json`
  or `~/.config/umans-gate/config.json`
- Windows: `%APPDATA%/umans-gate/config.json`
- Precedence: env vars > JSON file > built-in defaults
- Existing configs never overwritten on first run

## Related

- Source: src/viewer.ts (route handlers), src/config/* (modules)
- Update flow: `/dashboard/api/version` + `/dashboard/api/update`
