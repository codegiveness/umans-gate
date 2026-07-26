# Config Tab Reference

> **Applies to:** umans-gate v0.3.27 · **Last updated:** 2026-07-26

## Tab

- **Name**: Config
- **Value**: `config`
- **Lazy**: Yes

## Components

| File | Component |
|---|---|
| dashboard/src/components/config-tab.tsx | ConfigTab |
| dashboard/src/components/config-fields.tsx | ConfigFields |

## Data Source

- src/config.ts (barrel) re-exports:
  - `loadConfig` — src/config/loader.ts
  - `DEFAULT_CONFIG` — src/config/defaults.ts
  - `saveConfigLocked` — src/config/file.ts:90
  - `resetConfig` — src/config/file.ts:115
  - `validateConfig` — src/config/validation.ts:727
  - `applyReloadToConfig` — src/config/reload.ts

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
- `version` message — version info + update check
- Config changes do not broadcast; client refetches after save

## Purpose

Edit proxy settings and reload live or restart. Hot-reloadable fields
(e.g. `stamp_claude_code_enabled`, `breaker_*`, `rate_limit_*`,
7 `vision_*` intent fields) apply without restart. Fields marked
`restartRequired` (e.g. `port`, `db_path`, `upstream_protocol`) require
server restart via `/restart` or process manager.

## Config File

- Linux/macOS: `$XDG_CONFIG_HOME/umans-gate/config.json`
  or `~/.config/umans-gate/config.json`
- Windows: `%APPDATA%/umans-gate/config.json`
- Precedence: env vars > JSON file > built-in defaults
- Existing configs never overwritten on first run

## Related

- Source: src/viewer.ts (route handlers), src/config/* (modules)
- Update flow: `/dashboard/api/version` + `/dashboard/api/update`
