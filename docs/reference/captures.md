# Captures Tab Reference

> **Applies to:** umans-gate v0.4.0 · **Last updated:** 2026-07-26

## Tab

- **Name**: Captures
- **Value**: `captures`
- **Lazy**: No (always loaded)

## Components

| File | Component |
|---|---|
| dashboard/src/components/capture-list.tsx | CaptureList |
| dashboard/src/components/capture-detail.tsx | CaptureDetailPanel |
| dashboard/src/components/capture-row-item.tsx | CaptureRowItem |
| dashboard/src/components/body-renderer.tsx | BodyRenderer |
| dashboard/src/components/sse-viewer.tsx | SseViewer |
| dashboard/src/components/headers-viewer.tsx | HeadersViewer |
| dashboard/src/components/json-viewer.tsx | JsonViewer |

## Data Source

- `CaptureDB` — src/db.ts
  - Ring-buffered SQLite capture store (WAL mode)
  - Stores request/response pairs, headers, streamed chunks

## REST Endpoints

All prefixed `/dashboard/api/`.

| Method | Path | Purpose |
|---|---|---|
| GET | /captures | List captures (limit param, max 1000) |
| GET | /captures/:id | Full capture detail (regex route) |
| POST | /clear | Clear all captures + vision records |

## WebSocket

- Endpoint: `/dashboard/ws`
- Messages:
  - `new` — new capture started (CaptureSummary)
  - `update` — capture updated (final body, status)
  - `clear` — all captures cleared
  - `state` — capture state change (`streaming`, `failed`)
  - `prune` — captures pruned from ring buffer

## Purpose

Live log of every intercepted LLM API call. Master-detail layout: row list on
left, full inspection on right. Shows request headers/body, response headers,
streamed SSE chunks, timing, tokens, and model. Backed by `WriteQueue`
(src/queue.ts) for batched non-blocking persistence.

## Related

- Source: src/proxy.ts (capture injection), src/queue.ts (write-behind)
- Config: `max_captures` (default 200), `capture_body_max_bytes` (10MB)
