# KV Cache Hit Rate Benchmark — Sequential Conversation

**Date:** 2026-07-05 07:27:47 UTC
**API:** `https://api.code.umans.ai/v1`
**API Key:** `sk-f1qgI...tmJI`
**Images tested:** 2 per session (from `~/umans-gate/.omo/`)
**Test runs:** 7
**Timeout:** 180s (3 min) per request
**Conversation shape:** 1 conversation, 2 sequential user messages (1 image or 1 text per message)

## Methodology

- ONE conversation per session, 2 sequential user messages.
- Each message carries 1 image (direct) or 1 text description (handoff).
- Assistant response appended after each turn → conversation grows → KV cache warms up.
- Measure cache hit rate on EACH turn, with focus on the last (T2) response.
- Flash handoff: `reasoning: {type: none}` + `max_tokens: 512` to avoid null content.
- `top_k: -1` added to every request body (required by glm-5.2).

Cache metric sources:
- `/v1/chat/completions`: `usage.prompt_tokens_details.cached_tokens`
- `/v1/messages`: `usage.cache_read_input_tokens`

## Summary — KV Cache Hit Rate per Turn (all sessions)

| Session | Model | Endpoint | T1 | T2 | Aggregate |
|---------|-------|----------|--- | --- |-----------|
| 1a-flash-seq-images-openai | `umans-flash` | `/v1/chat/completions` | 0.0% | 64.57% | **38.89%** |
| 1b-flash-seq-images-anthropic | `umans-flash` | `/v1/messages` | 97.8% | 99.21% | **98.65%** |
| 2a-flash-seq-text-openai | `umans-flash` | `/v1/chat/completions` | 0.0% | 63.05% | **37.21%** |
| 2b-flash-seq-text-anthropic | `umans-flash` | `/v1/messages` | 90.78% | 94.58% | **93.02%** |
| 3-glm-seq-images-anthropic | `umans-glm-5.2` | `/v1/messages` | 0.0% | 0.0% | **0.0%** |
| 4a-glm-seq-text-openai | `umans-glm-5.2` | `/v1/chat/completions` | 0.0% | 78.24% | **43.07%** |
| 4b-glm-seq-text-anthropic | `umans-glm-5.2` | `/v1/messages` | 0.0% | 78.24% | **43.07%** |

## KV Cache Hit Rate on LAST turn (T2)

| Session | Model | Endpoint | Last Turn Hit Rate | Last Turn Tokens | Last Turn Cached |
|---------|-------|----------|-------------------|------------------|------------------|
| 1a-flash-seq-images-openai | `umans-flash` | `/v1/chat/completions` | 64.57% | 4064 | 2624 |
| 1b-flash-seq-images-anthropic | `umans-flash` | `/v1/messages` | 99.21% | 4064 | 4032 |
| 2a-flash-seq-text-openai | `umans-flash` | `/v1/chat/completions` | 63.05% | 406 | 256 |
| 2b-flash-seq-text-anthropic | `umans-flash` | `/v1/messages` | 94.58% | 406 | 384 |
| 3-glm-seq-images-anthropic | `umans-glm-5.2` | `/v1/messages` | 0.0% | 504 | 0 |
| 4a-glm-seq-text-openai | `umans-glm-5.2` | `/v1/chat/completions` | 78.24% | 409 | 320 |
| 4b-glm-seq-text-anthropic | `umans-glm-5.2` | `/v1/messages` | 78.24% | 409 | 320 |

## Session Details

### 1a-flash-seq-images-openai
- **Model:** `umans-flash`
- **Endpoint:** `/v1/chat/completions`
- **Strategy:** sequential 1 image/message × 2
- **Timestamp:** 2026-07-05T07:25:02.913330+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 5.87s | 2683 | 0 | 0.0% |
| 2 | 200 | 4.67s | 4064 | 2624 | 64.57% |


### 1b-flash-seq-images-anthropic
- **Model:** `umans-flash`
- **Endpoint:** `/v1/messages`
- **Strategy:** sequential 1 image/message × 2
- **Timestamp:** 2026-07-05T07:25:02.913330+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 3.78s | 2683 | 2624 | 97.8% |
| 2 | 200 | 4.45s | 4064 | 4032 | 99.21% |


### 2a-flash-seq-text-openai
- **Model:** `umans-flash`
- **Endpoint:** `/v1/chat/completions`
- **Strategy:** flash handoff → sequential 1 text/message × 2
- **Timestamp:** 2026-07-05T07:25:02.914463+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 2.64s | 282 | 0 | 0.0% |
| 2 | 200 | 2.42s | 406 | 256 | 63.05% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A large | 5.79s | 2488 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | This serene illustration depicts a green frog sitting on a large lily pad surrounded by gentle ripples and two pink lotu | 3.06s | 1407 | 200 |


### 2b-flash-seq-text-anthropic
- **Model:** `umans-flash`
- **Endpoint:** `/v1/messages`
- **Strategy:** flash handoff → sequential 1 text/message × 2
- **Timestamp:** 2026-07-05T07:25:02.914463+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 2.38s | 282 | 256 | 90.78% |
| 2 | 200 | 2.04s | 406 | 384 | 94.58% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A large | 5.79s | 2488 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | This serene illustration depicts a green frog sitting on a large lily pad surrounded by gentle ripples and two pink lotu | 3.06s | 1407 | 200 |


### 3-glm-seq-images-anthropic
- **Model:** `umans-glm-5.2`
- **Endpoint:** `/v1/messages`
- **Strategy:** server-side handoff, sequential 1 image/message × 2
- **Timestamp:** 2026-07-05T07:25:25.298825+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 69.95s | 433 | 0 | 0.0% |
| 2 | 200 | 69.15s | 504 | 0 | 0.0% |


### 4a-glm-seq-text-openai
- **Model:** `umans-glm-5.2`
- **Endpoint:** `/v1/chat/completions`
- **Strategy:** flash handoff → sequential 1 text/message × 2
- **Timestamp:** 2026-07-05T07:25:27.550728+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 8.12s | 334 | 0 | 0.0% |
| 2 | 200 | 25.85s | 409 | 320 | 78.24% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A large, textured toad with golden eyes sits on a wet, dark rock in the foreground, facing slightly to the right. The ba | 5.66s | 2488 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | A green frog sits peacefully on a large lily pad floating in the center of calm water, surrounded by gentle ripples and  | 3.28s | 1407 | 200 |


### 4b-glm-seq-text-anthropic
- **Model:** `umans-glm-5.2`
- **Endpoint:** `/v1/messages`
- **Strategy:** flash handoff → sequential 1 text/message × 2
- **Timestamp:** 2026-07-05T07:25:27.550728+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 12.12s | 334 | 0 | 0.0% |
| 2 | 200 | 18.79s | 409 | 320 | 78.24% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A large, textured toad with golden eyes sits on a wet, dark rock in the foreground, facing slightly to the right. The ba | 5.66s | 2488 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | A green frog sits peacefully on a large lily pad floating in the center of calm water, surrounded by gentle ripples and  | 3.28s | 1407 | 200 |


## Key Findings

- **Sequential conversation design**: 1 conversation, 2 messages, 1 image/text per message. KV cache warms as conversation grows.
- **Session 1** (flash direct images): Tests whether 1 image per request avoids the 10-image limit. Measures cache warming on umans-flash.
- **Session 2** (flash handoff → text): Flash converts each image to text, then sequential text messages on umans-flash. No image limit applies.
- **Session 3** (glm server handoff): glm-5.2 via /v1/messages, 1 image per message. OpenAI path skipped (no vision).
- **Session 4** (glm flash handoff → text): Flash converts images, sequential text messages on glm-5.2. Both paths.
- **Focus metric**: KV cache hit rate on the LAST (T2) turn — this is where the cache is warmest and the benefit is maximal.
- **`top_k: -1`** added to all request bodies (OpenAI + Anthropic paths) — required by glm-5.2 to avoid errors.

---

*Benchmark harness: `benchmark/vision-handoff/benchmark.py`*
*Run: `2026-07-05 07:27:47 UTC`*