# KV Cache Hit Rate Benchmark — Sequential Conversation

**Date:** 2026-07-05 08:38:27 UTC
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
| 1a-flash-seq-images-openai | `umans-flash` | `/v1/chat/completions` | 0.0% | 64.54% | 74.2% | 68.22% | 76.23% | 80.68% | 95.04% | 97.99% | 89.61% | 92.31% | ERR400 | **83.57%** |
| 1b-flash-seq-images-anthropic | `umans-flash` | `/v1/messages` | 97.76% | 62.49% | 74.73% | 68.69% | 76.49% | 80.84% | 95.05% | 97.97% | 89.67% | 92.34% | ERR400 | **86.14%** |
| 2a-flash-seq-text-openai | `umans-flash` | `/v1/chat/completions` | 0.0% | 51.0% | 51.04% | 59.65% | 44.1% | 49.54% | 64.91% | 55.78% | 62.42% | 68.76% | 73.42% | **61.3%** |
| 2b-flash-seq-text-anthropic | `umans-flash` | `/v1/messages` | 87.67% | 89.24% | 91.87% | 93.74% | 98.01% | 99.09% | 97.36% | 98.89% | 99.87% | 98.73% | 85.66% | **95.25%** |
| 3-glm-seq-images-anthropic | `umans-glm-5.2` | `/v1/messages` | 48.03% | 70.33% | 56.64% | 70.07% | 61.71% | 63.84% | 41.03% | 55.43% | 63.96% | 63.4% | ERR400 | **58.8%** |
| 4a-glm-seq-text-openai | `umans-glm-5.2` | `/v1/chat/completions` | ERRexception | 0.0% | 36.82% | 48.46% | 76.19% | 82.49% | 76.61% | 86.14% | 87.57% | ERRexception | ERRexception | **76.21%** |
| 4b-glm-seq-text-anthropic | `umans-glm-5.2` | `/v1/messages` | ERRexception | 0.0% | 19.28% | 57.97% | 84.48% | 87.1% | 79.76% | 83.01% | 85.19% | 84.66% | 88.98% | **79.64%** |

## KV Cache Hit Rate on LAST turn (T11)

| Session | Model | Endpoint | Last Turn Hit Rate | Last Turn Tokens | Last Turn Cached |
|---------|-------|----------|-------------------|------------------|------------------|
| 1a-flash-seq-images-openai | `umans-flash` | `/v1/chat/completions` | ERR (400) | — | — |
| 1b-flash-seq-images-anthropic | `umans-flash` | `/v1/messages` | ERR (400) | — | — |
| 2a-flash-seq-text-openai | `umans-flash` | `/v1/chat/completions` | 73.42% | 4184 | 3072 |
| 2b-flash-seq-text-anthropic | `umans-flash` | `/v1/messages` | 85.66% | 4184 | 3584 |
| 3-glm-seq-images-anthropic | `umans-glm-5.2` | `/v1/messages` | ERR (400) | — | — |
| 4a-glm-seq-text-openai | `umans-glm-5.2` | `/v1/chat/completions` | ERR (exception) | — | — |
| 4b-glm-seq-text-anthropic | `umans-glm-5.2` | `/v1/messages` | 88.98% | 4819 | 4288 |

## Session Details

### 1a-flash-seq-images-openai
- **Model:** `umans-flash`
- **Endpoint:** `/v1/chat/completions`
- **Strategy:** sequential 1 image/message × 11
- **Timestamp:** 2026-07-05T07:52:04.029370+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 5.45s | 2684 | 0 | 0.0% |
| 2 | 200 | 5.51s | 4066 | 2624 | 64.54% |
| 3 | 200 | 4.91s | 5434 | 4032 | 74.2% |
| 4 | 200 | 4.51s | 7880 | 5376 | 68.22% |
| 5 | 200 | 4.52s | 10326 | 7872 | 76.23% |
| 6 | 200 | 4.38s | 12772 | 10304 | 80.68% |
| 7 | 200 | 5.02s | 13401 | 12736 | 95.04% |
| 8 | 200 | 4.44s | 13651 | 13376 | 97.99% |
| 9 | 200 | 4.38s | 15212 | 13632 | 89.61% |
| 10 | 200 | 5.19s | 16432 | 15168 | 92.31% |
| 11 | 400 | 1.12s | — | — | ERR (400) |


### 1b-flash-seq-images-anthropic
- **Model:** `umans-flash`
- **Endpoint:** `/v1/messages`
- **Strategy:** sequential 1 image/message × 11
- **Timestamp:** 2026-07-05T07:52:04.029370+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 4.49s | 2684 | 2624 | 97.76% |
| 2 | 200 | 4.13s | 4199 | 2624 | 62.49% |
| 3 | 200 | 4.99s | 5567 | 4160 | 74.73% |
| 4 | 200 | 5.28s | 8013 | 5504 | 68.69% |
| 5 | 200 | 4.78s | 10459 | 8000 | 76.49% |
| 6 | 200 | 5.22s | 12905 | 10432 | 80.84% |
| 7 | 200 | 5.21s | 13534 | 12864 | 95.05% |
| 8 | 200 | 5.1s | 13784 | 13504 | 97.97% |
| 9 | 200 | 4.67s | 15345 | 13760 | 89.67% |
| 10 | 200 | 5.43s | 16565 | 15296 | 92.34% |
| 11 | 400 | 1.3s | — | — | ERR (400) |


### 2a-flash-seq-text-openai
- **Model:** `umans-flash`
- **Endpoint:** `/v1/chat/completions`
- **Strategy:** flash handoff → sequential 1 text/message × 11
- **Timestamp:** 2026-07-05T07:54:09.230545+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 2.0s | 365 | 0 | 0.0% |
| 2 | 200 | 2.35s | 502 | 256 | 51.0% |
| 3 | 200 | 2.07s | 627 | 320 | 51.04% |
| 4 | 200 | 2.16s | 751 | 448 | 59.65% |
| 5 | 200 | 2.27s | 1306 | 576 | 44.1% |
| 6 | 200 | 2.42s | 1421 | 704 | 49.54% |
| 7 | 200 | 2.17s | 1972 | 1280 | 64.91% |
| 8 | 200 | 2.27s | 2524 | 1408 | 55.78% |
| 9 | 200 | 2.15s | 3076 | 1920 | 62.42% |
| 10 | 200 | 2.19s | 3630 | 2496 | 68.76% |
| 11 | 200 | 2.56s | 4184 | 3072 | 73.42% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A large, highly detailed toad sits prominently on a wet, dark rock in the foreground, facing slightly right with large,  | 4.97s | 2489 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | A green frog sits atop a large lily pad in the center of a calm body of water, with two pink lotus buds visible to its l | 2.84s | 1408 | 200 |
| 3 | compressed_image (2).jpeg | A serene digital painting depicts a green frog resting on a large lily pad floating in calm water, surrounded by gentle, | 2.47s | 1395 | 200 |
| 4 | compressed_image (3).jpeg | A large, textured toad sits prominently on a wet, dark rock in the foreground, its skin detailed with bumps and wrinkles | 2.86s | 2473 | 200 |
| 5 | compressed_image (4).jpeg | The user wants a concise description of the provided image. The image is a photorealistic or AI-generated picture of a l | 3.09s | 2473 | 200 |
| 6 | compressed_image (5).jpeg | A large, textured toad perches on a dark, wet rock in the foreground, bathed in a warm, dramatic light that highlights i | 2.31s | 2473 | 200 |
| 7 | ss.png | The user wants a description of the provided image. 1.  **Identify the image type:** It is a screenshot of a text editor | 2.91s | 656 | 200 |
| 8 | ss2.png | The user wants a concise description of the provided image.  **Image Analysis:** 1.  **Subject:** It's a screenshot of a | 2.03s | 277 | 200 |
| 9 | ss3.png | The user wants a concise description of the provided image, which is a screenshot of a chat interface.  1.  **Identify t | 2.71s | 1588 | 200 |
| 10 | ss4.png | The user wants a concise description of the provided screenshot.  **1. Identify the main subject:** The image is a scree | 2.9s | 1246 | 200 |
| 11 | ss5.png | The user wants a concise description of the provided terminal screenshot.  1.  **Identify the main components:**     *   | 2.39s | 658 | 200 |


### 2b-flash-seq-text-anthropic
- **Model:** `umans-flash`
- **Endpoint:** `/v1/messages`
- **Strategy:** flash handoff → sequential 1 text/message × 11
- **Timestamp:** 2026-07-05T07:54:09.230545+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 2.3s | 365 | 320 | 87.67% |
| 2 | 200 | 2.63s | 502 | 448 | 89.24% |
| 3 | 200 | 2.32s | 627 | 576 | 91.87% |
| 4 | 200 | 2.72s | 751 | 704 | 93.74% |
| 5 | 200 | 3.62s | 1306 | 1280 | 98.01% |
| 6 | 200 | 2.39s | 1421 | 1408 | 99.09% |
| 7 | 200 | 2.31s | 1972 | 1920 | 97.36% |
| 8 | 200 | 2.58s | 2524 | 2496 | 98.89% |
| 9 | 200 | 2.75s | 3076 | 3072 | 99.87% |
| 10 | 200 | 2.88s | 3630 | 3584 | 98.73% |
| 11 | 200 | 2.21s | 4184 | 3584 | 85.66% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A large, highly detailed toad sits prominently on a wet, dark rock in the foreground, facing slightly right with large,  | 4.97s | 2489 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | A green frog sits atop a large lily pad in the center of a calm body of water, with two pink lotus buds visible to its l | 2.84s | 1408 | 200 |
| 3 | compressed_image (2).jpeg | A serene digital painting depicts a green frog resting on a large lily pad floating in calm water, surrounded by gentle, | 2.47s | 1395 | 200 |
| 4 | compressed_image (3).jpeg | A large, textured toad sits prominently on a wet, dark rock in the foreground, its skin detailed with bumps and wrinkles | 2.86s | 2473 | 200 |
| 5 | compressed_image (4).jpeg | The user wants a concise description of the provided image. The image is a photorealistic or AI-generated picture of a l | 3.09s | 2473 | 200 |
| 6 | compressed_image (5).jpeg | A large, textured toad perches on a dark, wet rock in the foreground, bathed in a warm, dramatic light that highlights i | 2.31s | 2473 | 200 |
| 7 | ss.png | The user wants a description of the provided image. 1.  **Identify the image type:** It is a screenshot of a text editor | 2.91s | 656 | 200 |
| 8 | ss2.png | The user wants a concise description of the provided image.  **Image Analysis:** 1.  **Subject:** It's a screenshot of a | 2.03s | 277 | 200 |
| 9 | ss3.png | The user wants a concise description of the provided image, which is a screenshot of a chat interface.  1.  **Identify t | 2.71s | 1588 | 200 |
| 10 | ss4.png | The user wants a concise description of the provided screenshot.  **1. Identify the main subject:** The image is a scree | 2.9s | 1246 | 200 |
| 11 | ss5.png | The user wants a concise description of the provided terminal screenshot.  1.  **Identify the main components:**     *   | 2.39s | 658 | 200 |


### 3-glm-seq-images-anthropic
- **Model:** `umans-glm-5.2`
- **Endpoint:** `/v1/messages`
- **Strategy:** server-side handoff, sequential 1 image/message × 11
- **Timestamp:** 2026-07-05T07:55:56.613410+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 60.58s | 533 | 256 | 48.03% |
| 2 | 200 | 45.6s | 455 | 320 | 70.33% |
| 3 | 200 | 62.51s | 678 | 384 | 56.64% |
| 4 | 200 | 103.25s | 548 | 384 | 70.07% |
| 5 | 200 | 94.93s | 726 | 448 | 61.71% |
| 6 | 200 | 72.08s | 802 | 512 | 63.84% |
| 7 | 200 | 93.81s | 1248 | 512 | 41.03% |
| 8 | 200 | 99.96s | 1270 | 704 | 55.43% |
| 9 | 200 | 146.14s | 1501 | 960 | 63.96% |
| 10 | 200 | 89.66s | 1817 | 1152 | 63.4% |
| 11 | 400 | 1.57s | — | — | ERR (400) |


### 4a-glm-seq-text-openai
- **Model:** `umans-glm-5.2`
- **Endpoint:** `/v1/chat/completions`
- **Strategy:** flash handoff → sequential 1 text/message × 11
- **Timestamp:** 2026-07-05T08:10:39.283222+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | exception | 180.01s | — | — | ERR (exception) |
| 2 | 200 | 169.72s | 339 | 0 | 0.0% |
| 3 | 200 | 171.95s | 869 | 320 | 36.82% |
| 4 | 200 | 43.25s | 1717 | 832 | 48.46% |
| 5 | 200 | 71.28s | 2184 | 1664 | 76.19% |
| 6 | 200 | 85.17s | 2638 | 2176 | 82.49% |
| 7 | 200 | 95.88s | 3425 | 2624 | 76.61% |
| 8 | 200 | 32.94s | 3938 | 3392 | 86.14% |
| 9 | 200 | 116.5s | 4458 | 3904 | 87.57% |
| 10 | exception | 180.05s | — | — | ERR (exception) |
| 11 | exception | 180.47s | — | — | ERR (exception) |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A large, textured toad with bumpy, olive-green skin sits prominently on a wet, dark rock in the foreground. Its large ey | 4.7s | 2489 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | This digital illustration depicts a serene scene with a green frog resting centrally on a large lily pad in calm, rippli | 3.1s | 1408 | 200 |
| 3 | compressed_image (2).jpeg | The user wants a concise description of the image, specifically focusing on visible text, UI elements, colors, and layou | 2.34s | 1395 | 200 |
| 4 | compressed_image (3).jpeg | The user wants a concise description of the provided image. The description needs to focus on visible text, UI elements, | 2.68s | 2473 | 200 |
| 5 | compressed_image (4).jpeg | A close-up shot features a large, textured frog with bumpy, brownish-green skin perched prominently on a dark, wet rock  | 2.61s | 2473 | 200 |
| 6 | compressed_image (5).jpeg | A large, textured toad with bumpy, greenish-brown skin sits prominently on a wet, dark rock in the foreground, gazing to | 2.31s | 2473 | 200 |
| 7 | ss.png | The user wants a concise description of the provided image.  1.  **Identify the image type:** It's a screenshot of a tex | 2.27s | 656 | 200 |
| 8 | ss2.png | The user wants a concise description of the provided image. The image shows a screenshot of a web development tool, like | 2.27s | 277 | 200 |
| 9 | ss3.png | The user wants a description of the provided screenshot.  1.  **Analyze the image:**     *   It's a screenshot of a term | 2.28s | 1588 | 200 |
| 10 | ss4.png | The user wants a concise description of the provided image.  **1. Identify the main subject:** The image is a screenshot | 2.93s | 1246 | 200 |
| 11 | ss5.png | The user wants a concise description of the provided image.  1.  **Analyze the image content:**     *   It's a screensho | 2.21s | 658 | 200 |


### 4b-glm-seq-text-anthropic
- **Model:** `umans-glm-5.2`
- **Endpoint:** `/v1/messages`
- **Strategy:** flash handoff → sequential 1 text/message × 11
- **Timestamp:** 2026-07-05T08:10:39.283222+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | exception | 180.56s | — | — | ERR (exception) |
| 2 | 200 | 7.76s | 339 | 0 | 0.0% |
| 3 | 200 | 6.67s | 996 | 192 | 19.28% |
| 4 | 200 | 5.19s | 1656 | 960 | 57.97% |
| 5 | 200 | 6.72s | 1894 | 1600 | 84.48% |
| 6 | 200 | 12.05s | 2131 | 1856 | 87.1% |
| 7 | 200 | 39.8s | 2648 | 2112 | 79.76% |
| 8 | 200 | 8.58s | 3161 | 2624 | 83.01% |
| 9 | 200 | 7.09s | 3681 | 3136 | 85.19% |
| 10 | 200 | 7.02s | 4309 | 3648 | 84.66% |
| 11 | 200 | 7.83s | 4819 | 4288 | 88.98% |

#### Handoff Phase (image → text via umans-flash)

| # | Image | Description | Elapsed | Tokens | Status |
|---|-------|-------------|---------|--------|--------|
| 1 | Gemini_Generated_Image_7s2k6a7s2k6a7s2k.png | A large, textured toad with bumpy, olive-green skin sits prominently on a wet, dark rock in the foreground. Its large ey | 4.7s | 2489 | 200 |
| 2 | Gemini_Generated_Image_u89j9fu89j9fu89j.png | This digital illustration depicts a serene scene with a green frog resting centrally on a large lily pad in calm, rippli | 3.1s | 1408 | 200 |
| 3 | compressed_image (2).jpeg | The user wants a concise description of the image, specifically focusing on visible text, UI elements, colors, and layou | 2.34s | 1395 | 200 |
| 4 | compressed_image (3).jpeg | The user wants a concise description of the provided image. The description needs to focus on visible text, UI elements, | 2.68s | 2473 | 200 |
| 5 | compressed_image (4).jpeg | A close-up shot features a large, textured frog with bumpy, brownish-green skin perched prominently on a dark, wet rock  | 2.61s | 2473 | 200 |
| 6 | compressed_image (5).jpeg | A large, textured toad with bumpy, greenish-brown skin sits prominently on a wet, dark rock in the foreground, gazing to | 2.31s | 2473 | 200 |
| 7 | ss.png | The user wants a concise description of the provided image.  1.  **Identify the image type:** It's a screenshot of a tex | 2.27s | 656 | 200 |
| 8 | ss2.png | The user wants a concise description of the provided image. The image shows a screenshot of a web development tool, like | 2.27s | 277 | 200 |
| 9 | ss3.png | The user wants a description of the provided screenshot.  1.  **Analyze the image:**     *   It's a screenshot of a term | 2.28s | 1588 | 200 |
| 10 | ss4.png | The user wants a concise description of the provided image.  **1. Identify the main subject:** The image is a screenshot | 2.93s | 1246 | 200 |
| 11 | ss5.png | The user wants a concise description of the provided image.  1.  **Analyze the image content:**     *   It's a screensho | 2.21s | 658 | 200 |


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
*Run: `2026-07-05 08:38:27 UTC`*