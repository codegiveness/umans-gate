# Vision Calls Tab Reference

> **Applies to:** umans-gate v0.5.7 · **Last updated:** 2026-07-30

The Vision Calls tab inspects image-bearing requests and their model-generated text descriptions.

## Tab

- **Name**: Vision Calls
- **Value**: `vision`
- **Lazy**: Yes

## Component

| File | Component |
|---|---|
| dashboard/src/components/vision-calls.tsx | VisionCalls |

## Data source

- `VisionHandoff` (src/vision/handoff.ts:196)
  - Orchestrates async image description generation
  - Backed by `vision-description-store.ts` (persistent cache)
- `VisionConfig` (src/vision/handoff.ts:72)
- Detection / triage: src/vision/detect.ts, src/vision/triage.ts

## REST Endpoints

All prefixed `/dashboard/api/`.

| Method | Path | Purpose |
|---|---|---|
| GET | /vision-calls | Vision call records (limit param, max 500) |
| DELETE | /vision-calls | Clear vision call records |
| GET | /vision-cache-stats | Vision description cache stats |

## WebSocket

- Endpoint: `/dashboard/ws`
- Messages:
  - `new`: new vision record (with description)
  - `update`: vision record updated (description arrived)
  - `vision-clear`: vision records cleared

## What the Vision Calls Tab Shows

The Vision Calls tab shows image-bearing requests with their model-generated descriptions. Each row links the original capture to its async vision description and displays the prompt strategy, model used, token cost, cache hit/miss, and generated text.

## Config (hot-reloadable)

- `vision_strategy` (catalog), `vision_model` (umans-flash)
- `vision_max_images` (5), `vision_max_description_tokens` (4096)
- `vision_cache_size` (1000), `vision_cache_ttl_ms` (7d)
- 7 intent-aware fields: `vision_intent_strategy`, `vision_decomposition_*`,
  `vision_adjacent_text_max_chars`, `vision_recent_messages_count`,
  `vision_system_prompt_max_chars`

## Related

- Source: src/vision/sink.ts (WS broadcast), src/vision/image-processor.ts
