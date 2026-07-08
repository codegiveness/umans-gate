# KV Cache Hit Rate Benchmark — Sequential Conversation

**Date:** 2026-07-05 07:09:30 UTC
**API:** `https://api.code.umans.ai/v1`
**API Key:** `sk-f1qgI...tmJI`
**Images tested:** 2 per session (from `~/umans-gate/.omo/`)
**Test runs:** 2
**Timeout:** 180s (3 min) per request
**Conversation shape:** 1 conversation, 11 sequential user messages (1 image or 1 text per message)

## Methodology

- ONE conversation per session, 11 sequential user messages.
- Each message carries 1 image (direct) or 1 text description (handoff).
- Assistant response appended after each turn → conversation grows → KV cache warms up.
- Measure cache hit rate on EACH turn, with focus on the last (11th) response.
- Flash handoff: `reasoning: {type: none}` + `max_tokens: 512` to avoid null content.

Cache metric sources:
- `/v1/chat/completions`: `usage.prompt_tokens_details.cached_tokens`
- `/v1/messages`: `usage.cache_read_input_tokens`

## Summary — KV Cache Hit Rate per Turn (all sessions)

| Session | Model | Endpoint | T1 | T2 | Aggregate |
|---------|-------|----------|--- | --- |-----------|
| 1a-kimi-seq-images-openai | `umans-kimi-k2.7` | `/v1/chat/completions` | 99.62% | 62.32% | **76.67%** |
| 1b-kimi-seq-images-anthropic | `umans-kimi-k2.7` | `/v1/messages` | 99.62% | 63.2% | **77.3%** |

## KV Cache Hit Rate on LAST turn (T2)

| Session | Model | Endpoint | Last Turn Hit Rate | Last Turn Tokens | Last Turn Cached |
|---------|-------|----------|-------------------|------------------|------------------|
| 1a-kimi-seq-images-openai | `umans-kimi-k2.7` | `/v1/chat/completions` | 62.32% | 5443 | 3392 |
| 1b-kimi-seq-images-anthropic | `umans-kimi-k2.7` | `/v1/messages` | 63.2% | 5389 | 3406 |

## Session Details

### 1a-kimi-seq-images-openai
- **Model:** `umans-kimi-k2.7`
- **Endpoint:** `/v1/chat/completions`
- **Strategy:** sequential 1 image/message × 11
- **Timestamp:** 2026-07-05T07:06:51.024301+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 43.0s | 3405 | 3392 | 99.62% |
| 2 | 200 | 54.04s | 5443 | 3392 | 62.32% |


### 1b-kimi-seq-images-anthropic
- **Model:** `umans-kimi-k2.7`
- **Endpoint:** `/v1/messages`
- **Strategy:** sequential 1 image/message × 11
- **Timestamp:** 2026-07-05T07:06:51.024301+00:00

| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |
|------|--------|---------|-------------------|--------|----------|
| 1 | 200 | 42.46s | 3405 | 3392 | 99.62% |
| 2 | 200 | 14.35s | 5389 | 3406 | 63.2% |


## Key Findings

- **Sequential conversation design**: 1 conversation, 11 messages, 1 image/text per message. KV cache warms as conversation grows.
- **Session 1** (kimi direct images): Tests whether 1 image per request avoids the 10-image limit. Measures cache warming on kimi-k2.7.
- **Session 2** (kimi flash handoff → text): Flash converts each image to text, then 11 sequential text messages. No image limit applies.
- **Session 3** (glm server handoff): glm-5.2 via /v1/messages, 1 image per message. OpenAI path skipped (no vision).
- **Session 4** (glm flash handoff → text): Flash converts images, 11 sequential text messages on glm-5.2. Both paths.
- **Focus metric**: KV cache hit rate on the LAST (11th) turn — this is where the cache is warmest and the benefit is maximal.

---

*Benchmark harness: `benchmark/kv_cache_benchmark.py`*
*Run: `2026-07-05 07:09:30 UTC`*