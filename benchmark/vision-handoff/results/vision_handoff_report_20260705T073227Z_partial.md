# KV Cache Hit Rate Benchmark — Sequential Conversation

**Date:** 2026-07-05 07:51:23 UTC
**API:** `https://api.code.umans.ai/v1`
**API Key:** `sk-f1qgI...tmJI`
**Images tested:** 11 per session (from `~/umans-gate/.omo/`)
**Test runs:** 7
**Timeout:** 180s (3 min) per request
**Conversation shape:** 1 conversation, 11 sequential user messages (1 image or 1 text per message)

## Methodology

- ONE conversation per session, 11 sequential user messages.
- Each message carries 1 image (direct) or 1 text description (handoff).
- Assistant response appended after each turn → conversation grows → KV cache warms up.
- Measure cache hit rate on EACH turn, with focus on the last (T11) response.
- Flash handoff: `reasoning: {type: none}` + `max_tokens: 512` to avoid null content.
- `top_k: -1` added to every request body (required by glm-5.2).

Cache metric sources:
- `/v1/chat/completions`: `usage.prompt_tokens_details.cached_tokens`
- `/v1/messages`: `usage.cache_read_input_tokens`

## Summary — KV Cache Hit Rate per Turn (all sessions)

| Session | Model | Endpoint | T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | T11 | Aggregate |
|---------|-------|----------|--- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |-----------|
| 1a-flash-seq-images-openai | `umans-flash` | `/v1/chat/completions` | 0.0% | 64.54% | 74.2% | 68.08% | 76.11% | 80.57% | 94.92% | 97.86% | 89.51% | 92.21% | ERR400 | **83.47%** |
| 1b-flash-seq-images-anthropic | `umans-flash` | `/v1/messages` | 97.76% | 99.16% | 98.93% | 67.83% | 75.9% | 80.89% | 95.19% | 98.12% | 88.08% | 82.73% | ERR400 | **87.06%** |
| 2a-flash-seq-text-openai | `umans-flash` | `/v1/chat/completions` | 0.0% | 51.41% | 51.95% | 60.38% | 44.41% | 49.72% | 65.07% | 95.38% | 77.35% | 82.08% | 83.68% | **71.84%** |
| 2b-flash-seq-text-anthropic | `umans-flash` | `/v1/messages` | 88.89% | 89.96% | 93.51% | 94.88% | 98.69% | 90.4% | 97.61% | 98.56% | 99.81% | 98.49% | 99.37% | **97.42%** |
| 3-glm-seq-images-anthropic | `umans-glm-5.2` | `/v1/messages` | 0.0% | 53.24% | ERRexception | 62.38% | 53.48% | 54.17% | 48.81% | 44.96% | ERRexception | ERRexception | 62.59% | **50.22%** |
| 4a-glm-seq-text-openai | `umans-glm-5.2` | `/v1/chat/completions` | ERRexception | 0.0% | 72.89% | 80.5% | 63.01% | 56.1% | 59.12% | 70.65% | 75.85% | 87.39% | 80.66% | **74.34%** |
| 4b-glm-seq-text-anthropic | `umans-glm-5.2` | `/v1/messages` | 0.0% | 69.87% | 79.86% | 71.71% | 75.29% | 56.11% | 69.06% | 79.47% | 79.67% | 85.38% | 87.21% | **77.45%** |

## KV Cache Hit Rate on LAST turn (T11)

| Session | Model | Endpoint | Last Turn Hit Rate | Last Turn Tokens | Last Turn Cached |
|---------|-------|----------|-------------------|------------------|------------------|
| 1a-flash-seq-images-openai | `umans-flash` | `/v1/chat/completions` | ERR (400) | — | — |
| 1b-flash-seq-images-anthropic | `umans-flash` | `/v1/messages` | ERR (400) | — | — |
| 2a-flash-seq-text-openai | `umans-flash` | `/v1/chat/completions` | 83.68% | 3671 | 3072 |
| 2b-flash-seq-text-anthropic | `umans-flash` | `/v1/messages` | 99.37% | 3671 | 3648 |
| 3-glm-seq-images-anthropic | `umans-glm-5.2` | `/v1/messages` | 62.59% | 1227 | 768 |
| 4a-glm-seq-text-openai | `umans-glm-5.2` | `/v1/chat/completions` | 80.66% | 5316 | 4288 |
| 4b-glm-seq-text-anthropic | `umans-glm-5.2` | `/v1/messages` | 87.21% | 4403 | 3840 |

## Session Details

### 1a-flash-seq-images-openai
- **Model:** `umans-flash`
- **Endpoint:** `/v1/chat/completions`
- **Strategy:** sequential 1 image/message × 11
- **Timestamp:** 2026-07-05T07:32:27.091254+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 5.39s | 2684 | 0 | 0.0% |
| 2 | 200 | 4.16s | 4066 | 2624 | 64.54% |
| 3 | 200 | 4.27s | 5434 | 4032 | 74.2% |
| 4 | 200 | 4.21s | 7897 | 5376 | 68.08% |
| 5 | 200 | 4.14s | 10343 | 7872 | 76.11% |
| 6 | 200 | 4.31s | 12789 | 10304 | 80.57% |
| 7 | 200 | 4.5s | 13418 | 12736 | 94.92% |
| 8 | 200 | 4.78s | 13668 | 13376 | 97.86% |
| 9 | 200 | 4.79s | 15229 | 13632 | 89.51% |
| 10 | 200 | 4.35s | 16449 | 15168 | 92.21% |
| 11 | 400 | 1.13s | — | — | ERR (400) |


### 1b-flash-seq-images-anthropic
- **Model:** `umans-flash`
- **Endpoint:** `/v1/messages`
- **Strategy:** sequential 1 image/message × 11
- **Timestamp:** 2026-07-05T07:32:27.091254+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 3.57s | 2684 | 2624 | 97.76% |
| 2 | 200 | 4.86s | 4066 | 4032 | 99.16% |
| 3 | 200 | 5.29s | 5434 | 5376 | 98.93% |
| 4 | 200 | 4.58s | 7926 | 5376 | 67.83% |
| 5 | 200 | 4.33s | 10372 | 7872 | 75.9% |
| 6 | 200 | 5.28s | 12818 | 10368 | 80.89% |
| 7 | 200 | 4.82s | 13447 | 12800 | 95.19% |
| 8 | 200 | 4.61s | 13697 | 13440 | 98.12% |
| 9 | 200 | 4.65s | 15258 | 13440 | 88.08% |
| 10 | 200 | 4.78s | 16478 | 13632 | 82.73% |
| 11 | 400 | 1.44s | — | — | ERR (400) |


### 2a-flash-seq-text-openai
- **Model:** `umans-flash`
- **Endpoint:** `/v1/chat/completions`
- **Strategy:** flash handoff → sequential 1 text/message × 11
- **Timestamp:** 2026-07-05T07:32:27.092789+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 2.81s | 360 | 0 | 0.0% |
| 2 | 200 | 1.95s | 498 | 256 | 51.41% |
| 3 | 200 | 2.39s | 616 | 320 | 51.95% |
| 4 | 200 | 2.12s | 742 | 448 | 60.38% |
| 5 | 200 | 2.23s | 1297 | 576 | 44.41% |
| 6 | 200 | 2.03s | 1416 | 704 | 49.72% |
| 7 | 200 | 2.24s | 1967 | 1280 | 65.07% |
| 8 | 200 | 2.03s | 2013 | 1920 | 95.38% |
| 9 | 200 | 2.32s | 2565 | 1984 | 77.35% |
| 10 | 200 | 2.2s | 3119 | 2560 | 82.08% |
| 11 | 200 | 2.64s | 3671 | 3072 | 83.68% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A large, textured toad sits prominently on a wet, dark rock in the foreground, illuminated by soft light that highlights | 5.04s | 2489 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | This artwork features a green frog resting on a large green lily pad floating in calm, reflective water. Beside the frog | 4.95s | 1408 | 200 |
| 3 | compressed_image (2).jpeg | This serene, watercolor-style illustration depicts a green frog resting on a large lily pad in the middle of a calm body | 2.27s | 1395 | 200 |
| 4 | compressed_image (3).jpeg | A large, bumpy toad with greenish-brown skin perches on a dark, wet rock in the foreground, facing slightly to the right | 2.57s | 2473 | 200 |
| 5 | compressed_image (4).jpeg | The user wants a concise description of the image.  1.  **Subject:** The main subject is a large, textured toad or frog  | 2.7s | 2473 | 200 |
| 6 | compressed_image (5).jpeg | A large, detailed toad with bumpy, olive-green skin and prominent golden eyes sits perched on a wet, dark rock in the fo | 2.76s | 2473 | 200 |
| 7 | ss.png | The user wants a description of the provided image.  **1. Analyze the image:** - **Type:** It's a screenshot of a config | 2.45s | 656 | 200 |
| 8 | ss2.png | This image displays a dark-themed | 2.57s | 277 | 200 |
| 9 | ss3.png | The user wants a concise description of the provided image. I need to focus on the visible text, UI elements, and layout | 2.14s | 1588 | 200 |
| 10 | ss4.png | The user wants a concise description of the provided image. The image shows a software interface, likely a network traff | 3.45s | 1246 | 200 |
| 11 | ss5.png | The user wants a concise description of the provided image, which is a screenshot of a terminal interface.  1.  **Identi | 2.26s | 658 | 200 |


### 2b-flash-seq-text-anthropic
- **Model:** `umans-flash`
- **Endpoint:** `/v1/messages`
- **Strategy:** flash handoff → sequential 1 text/message × 11
- **Timestamp:** 2026-07-05T07:32:27.092789+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 3.3s | 360 | 320 | 88.89% |
| 2 | 200 | 2.68s | 498 | 448 | 89.96% |
| 3 | 200 | 2.96s | 616 | 576 | 93.51% |
| 4 | 200 | 2.1s | 742 | 704 | 94.88% |
| 5 | 200 | 2.23s | 1297 | 1280 | 98.69% |
| 6 | 200 | 1.88s | 1416 | 1280 | 90.4% |
| 7 | 200 | 2.4s | 1967 | 1920 | 97.61% |
| 8 | 200 | 3.44s | 2013 | 1984 | 98.56% |
| 9 | 200 | 2.15s | 2565 | 2560 | 99.81% |
| 10 | 200 | 2.81s | 3119 | 3072 | 98.49% |
| 11 | 200 | 1.99s | 3671 | 3648 | 99.37% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A large, textured toad sits prominently on a wet, dark rock in the foreground, illuminated by soft light that highlights | 5.04s | 2489 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | This artwork features a green frog resting on a large green lily pad floating in calm, reflective water. Beside the frog | 4.95s | 1408 | 200 |
| 3 | compressed_image (2).jpeg | This serene, watercolor-style illustration depicts a green frog resting on a large lily pad in the middle of a calm body | 2.27s | 1395 | 200 |
| 4 | compressed_image (3).jpeg | A large, bumpy toad with greenish-brown skin perches on a dark, wet rock in the foreground, facing slightly to the right | 2.57s | 2473 | 200 |
| 5 | compressed_image (4).jpeg | The user wants a concise description of the image.  1.  **Subject:** The main subject is a large, textured toad or frog  | 2.7s | 2473 | 200 |
| 6 | compressed_image (5).jpeg | A large, detailed toad with bumpy, olive-green skin and prominent golden eyes sits perched on a wet, dark rock in the fo | 2.76s | 2473 | 200 |
| 7 | ss.png | The user wants a description of the provided image.  **1. Analyze the image:** - **Type:** It's a screenshot of a config | 2.45s | 656 | 200 |
| 8 | ss2.png | This image displays a dark-themed | 2.57s | 277 | 200 |
| 9 | ss3.png | The user wants a concise description of the provided image. I need to focus on the visible text, UI elements, and layout | 2.14s | 1588 | 200 |
| 10 | ss4.png | The user wants a concise description of the provided image. The image shows a software interface, likely a network traff | 3.45s | 1246 | 200 |
| 11 | ss5.png | The user wants a concise description of the provided image, which is a screenshot of a terminal interface.  1.  **Identi | 2.26s | 658 | 200 |


### 3-glm-seq-images-anthropic
- **Model:** `umans-glm-5.2`
- **Endpoint:** `/v1/messages`
- **Strategy:** server-side handoff, sequential 1 image/message × 11
- **Timestamp:** 2026-07-05T07:34:16.158915+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 42.04s | 411 | 0 | 0.0% |
| 2 | 200 | 72.49s | 601 | 320 | 53.24% |
| 3 | exception | 180.32s | — | — | ERR (exception) |
| 4 | 200 | 48.94s | 513 | 320 | 62.38% |
| 5 | 200 | 75.97s | 718 | 384 | 53.48% |
| 6 | 200 | 38.61s | 827 | 448 | 54.17% |
| 7 | 200 | 24.05s | 1049 | 512 | 48.81% |
| 8 | 200 | 72.47s | 1281 | 576 | 44.96% |
| 9 | exception | 180.15s | — | — | ERR (exception) |
| 10 | exception | 182.01s | — | — | ERR (exception) |
| 11 | 200 | 98.24s | 1227 | 768 | 62.59% |


### 4a-glm-seq-text-openai
- **Model:** `umans-glm-5.2`
- **Endpoint:** `/v1/chat/completions`
- **Strategy:** flash handoff → sequential 1 text/message × 11
- **Timestamp:** 2026-07-05T07:34:26.871529+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | exception | 180.05s | — | — | ERR (exception) |
| 2 | 200 | 73.99s | 336 | 0 | 0.0% |
| 3 | 200 | 7.14s | 439 | 320 | 72.89% |
| 4 | 200 | 11.4s | 477 | 384 | 80.5% |
| 5 | 200 | 11.63s | 711 | 448 | 63.01% |
| 6 | 200 | 8.65s | 1255 | 704 | 56.1% |
| 7 | 200 | 7.59s | 2057 | 1216 | 59.12% |
| 8 | 200 | 8.81s | 2899 | 2048 | 70.65% |
| 9 | 200 | 8.04s | 3797 | 2880 | 75.85% |
| 10 | 200 | 10.61s | 4321 | 3776 | 87.39% |
| 11 | 200 | 8.61s | 5316 | 4288 | 80.66% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A highly detailed toad with bumpy, greenish-brown skin rests on a dark, wet rock in the foreground, gazing toward the ri | 5.05s | 2489 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | This watercolor-style illustration depicts a green frog resting on a large lily pad in the center of a calm, rippling bo | 3.21s | 1408 | 200 |
| 3 | compressed_image (2).jpeg | A green frog sits calmly on a large, circular lily pad floating in the center of a serene body of water. To the left, tw | 2.44s | 1395 | 200 |
| 4 | compressed_image (3).jpeg | A large, | 2.88s | 2473 | 200 |
| 5 | compressed_image (4).jpeg | A hyper-realistic, close-up shot captures a large, textured toad perched on a wet, dark rock in the foreground. The back | 2.77s | 2473 | 200 |
| 6 | compressed_image (5).jpeg | The user wants a concise description of the provided image. - **Subject:** A large, detailed toad or frog. - **Position: | 3.06s | 2473 | 200 |
| 7 | ss.png | The user wants a concise description of the provided image.  1.  **Identify the content:** It's a screenshot of a text f | 2.49s | 656 | 200 |
| 8 | ss2.png | The user wants a concise description of the provided image.  1.  **Identify the main subject:** It's a screenshot of a n | 2.75s | 277 | 200 |
| 9 | ss3.png | The user wants a description of the provided image. 1.  **Identify the image type:** It's a screenshot of a chat interfa | 2.39s | 1588 | 200 |
| 10 | ss4.png | The user wants a concise description of the provided image.  1.  **Identify the main subject:** It's a screenshot of a s | 3.08s | 1246 | 200 |
| 11 | ss5.png | The user wants a concise description of the provided image. The image is a screenshot of a terminal interface, likely a  | 2.45s | 658 | 200 |


### 4b-glm-seq-text-anthropic
- **Model:** `umans-glm-5.2`
- **Endpoint:** `/v1/messages`
- **Strategy:** flash handoff → sequential 1 text/message × 11
- **Timestamp:** 2026-07-05T07:34:26.871529+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 5.71s | 334 | 0 | 0.0% |
| 2 | 200 | 6.03s | 458 | 320 | 69.87% |
| 3 | 200 | 13.8s | 561 | 448 | 79.86% |
| 4 | 200 | 8.5s | 714 | 512 | 71.71% |
| 5 | 200 | 7.96s | 935 | 704 | 75.29% |
| 6 | 200 | 9.19s | 1597 | 896 | 56.11% |
| 7 | 200 | 6.17s | 2224 | 1536 | 69.06% |
| 8 | 200 | 6.32s | 2738 | 2176 | 79.47% |
| 9 | 200 | 8.93s | 3374 | 2688 | 79.67% |
| 10 | 200 | 6.36s | 3898 | 3328 | 85.38% |
| 11 | 200 | 13.3s | 4403 | 3840 | 87.21% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A highly detailed toad with bumpy, greenish-brown skin rests on a dark, wet rock in the foreground, gazing toward the ri | 5.05s | 2489 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | This watercolor-style illustration depicts a green frog resting on a large lily pad in the center of a calm, rippling bo | 3.21s | 1408 | 200 |
| 3 | compressed_image (2).jpeg | A green frog sits calmly on a large, circular lily pad floating in the center of a serene body of water. To the left, tw | 2.44s | 1395 | 200 |
| 4 | compressed_image (3).jpeg | A large, | 2.88s | 2473 | 200 |
| 5 | compressed_image (4).jpeg | A hyper-realistic, close-up shot captures a large, textured toad perched on a wet, dark rock in the foreground. The back | 2.77s | 2473 | 200 |
| 6 | compressed_image (5).jpeg | The user wants a concise description of the provided image. - **Subject:** A large, detailed toad or frog. - **Position: | 3.06s | 2473 | 200 |
| 7 | ss.png | The user wants a concise description of the provided image.  1.  **Identify the content:** It's a screenshot of a text f | 2.49s | 656 | 200 |
| 8 | ss2.png | The user wants a concise description of the provided image.  1.  **Identify the main subject:** It's a screenshot of a n | 2.75s | 277 | 200 |
| 9 | ss3.png | The user wants a description of the provided image. 1.  **Identify the image type:** It's a screenshot of a chat interfa | 2.39s | 1588 | 200 |
| 10 | ss4.png | The user wants a concise description of the provided image.  1.  **Identify the main subject:** It's a screenshot of a s | 3.08s | 1246 | 200 |
| 11 | ss5.png | The user wants a concise description of the provided image. The image is a screenshot of a terminal interface, likely a  | 2.45s | 658 | 200 |


## Key Findings

- **Sequential conversation design**: 1 conversation, 11 messages, 1 image/text per message. KV cache warms as conversation grows.
- **Session 1** (flash direct images): Tests whether 1 image per request avoids the 10-image limit. Measures cache warming on umans-flash.
- **Session 2** (flash handoff → text): Flash converts each image to text, then sequential text messages on umans-flash. No image limit applies.
- **Session 3** (glm server handoff): glm-5.2 via /v1/messages, 1 image per message. OpenAI path skipped (no vision).
- **Session 4** (glm flash handoff → text): Flash converts images, sequential text messages on glm-5.2. Both paths.
- **Focus metric**: KV cache hit rate on the LAST (T11) turn — this is where the cache is warmest and the benefit is maximal.
- **`top_k: -1`** added to all request bodies (OpenAI + Anthropic paths) — required by glm-5.2 to avoid errors.

---

*Benchmark harness: `benchmark/vision-handoff/benchmark.py`*
*Run: `2026-07-05 07:51:23 UTC`*