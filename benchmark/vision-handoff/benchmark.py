#!/usr/bin/env python3
"""
KV Cache Hit Rate Benchmark — sequential multi-turn conversation.

Scenario (what the user actually wants):
  - ONE conversation per session.
  - N sequential user messages (default 11, set via --images N), each carrying
    1 image (or 1 text description for handoff).
  - Each turn: append user message → get response → record usage.
  - Goal: measure KV cache hit rate on the LAST response, plus the warming curve.

Sessions:
  S1. umans-flash with 1 image per message, N messages (OpenAI + Anthropic paths)
  S2. umans-flash with app handoff: flash converts each image → text,
       then N sequential user messages each with 1 text description (OpenAI + Anthropic)
  S3. glm-5.2 server-side handoff: 1 image per message, N messages via /v1/messages
       (OpenAI path skipped — glm-5.2 has no vision on /v1/chat/completions)
  S4. glm-5.2 with app handoff: flash → text, N sequential user messages (OpenAI + Anthropic)

Cache metrics:
  - /v1/chat/completions: usage.prompt_tokens_details.cached_tokens
  - /v1/messages:         usage.cache_read_input_tokens

Timeout: 180s (3 min) per request — server under load.

Parallel: sessions run concurrently (default 2 workers, set via --workers N).
  Each session runs its own API path(s) sequentially internally.
"""

import argparse
import base64
import json
import os
import time
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path

import httpx

# Force unbuffered stdout so live output is visible immediately
import functools
print = functools.partial(print, flush=True)  # type: ignore

API_BASE = "https://api.code.umans.ai/v1"
API_KEY = os.environ["UMANS_API_KEY"]
HEADERS = {
    "Authorization": f"Bearer {API_KEY}",
    "Content-Type": "application/json",
}


def session_headers(session_id: str) -> dict[str, str]:
    """Headers with x-session-affinity for KV cache routing."""
    return {**HEADERS, "x-session-affinity": session_id}

OMO_DIR = Path.home() / "umans-gate" / ".omo"
BENCH_DIR = Path(__file__).resolve().parent / "results"
BENCH_DIR.mkdir(parents=True, exist_ok=True)

TIMEOUT = 180

SYSTEM_PREFIX = """You are a meticulous visual analysis assistant. Your job is to carefully examine images and extract precise, structured information about what you see.

When presented with images, you must:
1. Identify the primary subject and context of each image.
2. Note any text, UI elements, code snippets, or diagrams visible.
3. Describe the layout, color scheme, and visual hierarchy.
4. Flag any anomalies, errors, or notable features.
5. Provide a concise summary at the end.

You maintain a running context of all previously analyzed images in this session, so you can reference and compare them across turns. Be thorough but structured in your responses. Use numbered lists for clarity. Always distinguish between what you can directly observe and what you are inferring.

Your response format:
- Image N: [filename]
- Subject: [brief]
- Key observations: [3-5 bullet points]
- Notable details: [any text/code/errors visible]

This structured approach ensures consistent analysis across all images in the session."""

HANDOFF_SYSTEM = "You are a vision assistant. Describe the image concisely in 2-3 sentences. Focus on visible text, UI elements, code, colors, and layout."


def load_images(count: int = 11) -> list[tuple[str, bytes, str]]:
    exts = ("*.png", "*.jpeg", "*.jpg")
    files = []
    for ext in exts:
        files.extend(sorted(OMO_DIR.glob(ext)))
    files = sorted(set(files))[:count]
    if len(files) < count:
        print(f"WARNING: only {len(files)} images found, needed {count}")
    result = []
    for f in files:
        ext = f.suffix.lower()
        mime = "image/png" if ext == ".png" else "image/jpeg"
        result.append((f.name, f.read_bytes(), mime))
    return result


def resize_if_needed(data: bytes, mime: str, max_dim: int = 1568) -> bytes:
    from io import BytesIO
    from PIL import Image

    img = Image.open(BytesIO(data))
    w, h = img.size
    if max(w, h) > max_dim:
        ratio = max_dim / max(w, h)
        new_size = (int(w * ratio), int(h * ratio))
        img = img.resize(new_size, Image.Resampling.LANCZOS)
    if img.mode in ("RGBA", "P"):
        img = img.convert("RGB")
    buf = BytesIO()
    fmt = "PNG" if mime == "image/png" else "JPEG"
    img.save(buf, format=fmt)
    return buf.getvalue()


def encode_image_b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def flash_describe_image(client: httpx.Client, name: str, data: bytes, mime: str, idx: int, total: int, session_id: str) -> dict:
    """Convert one image to text via umans-flash (reasoning disabled)."""
    resized = resize_if_needed(data, mime)
    b64 = encode_image_b64(resized)
    payload = {
        "model": "umans-flash",
        "messages": [
            {"role": "system", "content": HANDOFF_SYSTEM},
            {"role": "user", "content": [
                {"type": "text", "text": f"Describe this image (image {idx} of {total}, filename: {name}):"},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ]},
        ],
        "max_tokens": 512,
        "reasoning": {"type": "none"},
        "stream": False,
        "top_k": -1,
    }
    t0 = time.time()
    try:
        resp = client.post(f"{API_BASE}/chat/completions", json=payload, headers=session_headers(session_id), timeout=TIMEOUT)
        elapsed = time.time() - t0
        if resp.status_code == 200:
            body = resp.json()
            msg = body["choices"][0]["message"]
            desc = msg.get("content") or msg.get("reasoning_content") or "[empty]"
            usage = body.get("usage", {})
            print(f"    [{idx}/{total}] {name}: {elapsed:.1f}s — {desc[:80]}...")
            return {
                "filename": name, "description": desc, "elapsed_s": round(elapsed, 2),
                "tokens": usage.get("prompt_tokens", 0), "status": 200,
            }
        print(f"    [{idx}/{total}] {name}: HTTP {resp.status_code} — {resp.text[:200]}")
        return {
            "filename": name, "description": f"[ERROR: HTTP {resp.status_code}]",
            "elapsed_s": round(elapsed, 2), "status": resp.status_code, "error": resp.text[:500],
        }
    except Exception as e:
        print(f"    [{idx}/{total}] {name}: Exception — {e}")
        return {
            "filename": name, "description": f"[ERROR: {e}]",
            "elapsed_s": round(time.time() - t0, 2), "status": "exception", "error": str(e),
        }


# ---------------------------------------------------------------------------
# Sequential conversation runners — N turns, 1 image/text per turn
# ---------------------------------------------------------------------------


def run_openai_sequential_images(client: httpx.Client, model: str, images: list, label: str, session_id: str) -> dict:
    """
    OpenAI path: 1 conversation, N sequential user messages, each with 1 image.
    KV cache warms up as the conversation grows. Measure hit rate per turn.
    """
    n = len(images)
    print(f"\n  [{label}] OpenAI sequential: 1 image per message, {n} messages...")
    result: dict = {"label": label, "endpoint": "/v1/chat/completions", "turns": []}
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PREFIX}]
    hdrs = session_headers(session_id)

    for i, (name, data, mime) in enumerate(images, 1):
        resized = resize_if_needed(data, mime)
        b64 = encode_image_b64(resized)
        messages.append({
            "role": "user",
            "content": [
                {"type": "text", "text": f"Turn {i}/{n}. Here is image {i} ({name}). Describe what you see and relate it to previous images if applicable."},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        })
        payload = {"model": model, "messages": messages, "max_tokens": 512, "stream": False, "top_k": -1}
        t0 = time.time()
        try:
            resp = client.post(f"{API_BASE}/chat/completions", json=payload, headers=hdrs, timeout=TIMEOUT)
            elapsed = time.time() - t0
            if resp.status_code == 200:
                body = resp.json()
                usage = body.get("usage", {})
                total_input = usage.get("prompt_tokens", 0)
                cached = usage.get("prompt_tokens_details", {}).get("cached_tokens", 0)
                completion = usage.get("completion_tokens", 0)
                hit_rate = round(cached / total_input * 100, 2) if total_input else 0
                assistant_content = body["choices"][0]["message"]["content"]
                result["turns"].append({
                    "turn": i, "status": 200, "elapsed_s": round(elapsed, 2),
                    "prompt_tokens": total_input, "completion_tokens": completion,
                    "cached_tokens": cached, "cache_hit_rate_pct": hit_rate,
                })
                print(f"      T{i}: {elapsed:.1f}s — tokens={total_input}, cached={cached}, hit={hit_rate}%")
                messages.append({"role": "assistant", "content": assistant_content})
            else:
                print(f"      T{i}: HTTP {resp.status_code} — {resp.text[:200]}")
                result["turns"].append({"turn": i, "status": resp.status_code, "elapsed_s": round(elapsed, 2), "error": resp.text[:1000]})
                messages.pop()
        except Exception as e:
            print(f"      T{i}: Exception — {e}")
            result["turns"].append({"turn": i, "status": "exception", "elapsed_s": round(time.time() - t0, 2), "error": str(e)})
            messages.pop()
        if i < len(images):
            time.sleep(1)
    return result


def run_anthropic_sequential_images(client: httpx.Client, model: str, images: list, label: str, session_id: str) -> dict:
    """
    Anthropic path: 1 conversation, N sequential user messages, each with 1 image.
    """
    n = len(images)
    print(f"\n  [{label}] Anthropic sequential: 1 image per message, {n} messages...")
    result: dict = {"label": label, "endpoint": "/v1/messages", "turns": []}
    messages: list[dict] = []
    hdrs = session_headers(session_id)
    system_blocks = [{"type": "text", "text": SYSTEM_PREFIX, "cache_control": {"type": "ephemeral", "ttl": "1h"}}]

    for i, (name, data, mime) in enumerate(images, 1):
        resized = resize_if_needed(data, mime)
        b64 = encode_image_b64(resized)
        media_type = "image/jpeg" if "jpeg" in mime or "jpg" in mime else "image/png"
        is_last = i == n
        content_blocks = [
            {"type": "text", "text": f"Turn {i}/{n}. Here is image {i} ({name}). Describe what you see and relate it to previous images if applicable."},
            {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": b64}},
        ]
        if is_last:
            content_blocks[-1]["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
        messages.append({"role": "user", "content": content_blocks})
        payload = {"model": model, "max_tokens": 512, "system": system_blocks, "messages": messages, "top_k": -1}
        t0 = time.time()
        try:
            resp = client.post(f"{API_BASE}/messages", json=payload, headers=hdrs, timeout=TIMEOUT)
            elapsed = time.time() - t0
            if resp.status_code == 200:
                body = resp.json()
                usage = body.get("usage", {})
                input_tokens = usage.get("input_tokens", 0)
                output_tokens = usage.get("output_tokens", 0)
                cache_read = usage.get("cache_read_input_tokens", 0)
                cache_creation = usage.get("cache_creation_input_tokens", 0)
                total_input = input_tokens + cache_read + cache_creation
                hit_rate = round(cache_read / total_input * 100, 2) if total_input else 0
                content = body.get("content", [])
                text_parts = [b.get("text", "") for b in content if b.get("type") == "text"]
                assistant_text = " ".join(text_parts)[:500]
                result["turns"].append({
                    "turn": i, "status": 200, "elapsed_s": round(elapsed, 2),
                    "input_tokens": input_tokens, "output_tokens": output_tokens,
                    "cache_read_input_tokens": cache_read, "cache_creation_input_tokens": cache_creation,
                    "total_input_tokens": total_input, "cache_hit_rate_pct": hit_rate,
                })
                print(f"      T{i}: {elapsed:.1f}s — input={input_tokens}, cache_read={cache_read}, hit={hit_rate}%")
                messages.append({"role": "assistant", "content": assistant_text})
            else:
                print(f"      T{i}: HTTP {resp.status_code} — {resp.text[:200]}")
                result["turns"].append({"turn": i, "status": resp.status_code, "elapsed_s": round(elapsed, 2), "error": resp.text[:1000]})
                messages.pop()
        except Exception as e:
            print(f"      T{i}: Exception — {e}")
            result["turns"].append({"turn": i, "status": "exception", "elapsed_s": round(time.time() - t0, 2), "error": str(e)})
            messages.pop()
        if i < len(images):
            time.sleep(1)
    return result


def run_openai_sequential_text(client: httpx.Client, model: str, descriptions: list[dict], label: str, session_id: str) -> dict:
    """
    OpenAI path: 1 conversation, N sequential user messages, each with 1 text description.
    """
    n = len(descriptions)
    print(f"\n  [{label}] OpenAI sequential text: 1 description per message, {n} messages...")
    result: dict = {"label": label, "endpoint": "/v1/chat/completions", "turns": []}
    messages: list[dict] = [{"role": "system", "content": SYSTEM_PREFIX}]
    hdrs = session_headers(session_id)

    for i, d in enumerate(descriptions, 1):
        messages.append({
            "role": "user",
            "content": f"Turn {i}/{n}. Here is image {i} ({d['filename']}), described as: {d['description']}\n\nRelate this to previous images if applicable.",
        })
        payload = {"model": model, "messages": messages, "max_tokens": 512, "stream": False, "top_k": -1}
        t0 = time.time()
        try:
            resp = client.post(f"{API_BASE}/chat/completions", json=payload, headers=hdrs, timeout=TIMEOUT)
            elapsed = time.time() - t0
            if resp.status_code == 200:
                body = resp.json()
                usage = body.get("usage", {})
                total_input = usage.get("prompt_tokens", 0)
                cached = usage.get("prompt_tokens_details", {}).get("cached_tokens", 0)
                completion = usage.get("completion_tokens", 0)
                hit_rate = round(cached / total_input * 100, 2) if total_input else 0
                assistant_content = body["choices"][0]["message"]["content"]
                result["turns"].append({
                    "turn": i, "status": 200, "elapsed_s": round(elapsed, 2),
                    "prompt_tokens": total_input, "completion_tokens": completion,
                    "cached_tokens": cached, "cache_hit_rate_pct": hit_rate,
                })
                print(f"      T{i}: {elapsed:.1f}s — tokens={total_input}, cached={cached}, hit={hit_rate}%")
                messages.append({"role": "assistant", "content": assistant_content})
            else:
                print(f"      T{i}: HTTP {resp.status_code} — {resp.text[:200]}")
                result["turns"].append({"turn": i, "status": resp.status_code, "elapsed_s": round(elapsed, 2), "error": resp.text[:1000]})
                messages.pop()
        except Exception as e:
            print(f"      T{i}: Exception — {e}")
            result["turns"].append({"turn": i, "status": "exception", "elapsed_s": round(time.time() - t0, 2), "error": str(e)})
            messages.pop()
        if i < len(descriptions):
            time.sleep(1)
    return result


def run_anthropic_sequential_text(client: httpx.Client, model: str, descriptions: list[dict], label: str, session_id: str) -> dict:
    """
    Anthropic path: 1 conversation, N sequential user messages, each with 1 text description.
    """
    n = len(descriptions)
    print(f"\n  [{label}] Anthropic sequential text: 1 description per message, {n} messages...")
    result: dict = {"label": label, "endpoint": "/v1/messages", "turns": []}
    messages: list[dict] = []
    hdrs = session_headers(session_id)
    system_blocks = [{"type": "text", "text": SYSTEM_PREFIX, "cache_control": {"type": "ephemeral", "ttl": "1h"}}]

    for i, d in enumerate(descriptions, 1):
        is_last = i == n
        text_block: dict = {"type": "text", "text": f"Turn {i}/{n}. Here is image {i} ({d['filename']}), described as: {d['description']}\n\nRelate this to previous images if applicable."}
        if is_last:
            text_block["cache_control"] = {"type": "ephemeral", "ttl": "1h"}
        messages.append({"role": "user", "content": [text_block]})
        payload = {"model": model, "max_tokens": 512, "system": system_blocks, "messages": messages, "top_k": -1}
        t0 = time.time()
        try:
            resp = client.post(f"{API_BASE}/messages", json=payload, headers=hdrs, timeout=TIMEOUT)
            elapsed = time.time() - t0
            if resp.status_code == 200:
                body = resp.json()
                usage = body.get("usage", {})
                input_tokens = usage.get("input_tokens", 0)
                output_tokens = usage.get("output_tokens", 0)
                cache_read = usage.get("cache_read_input_tokens", 0)
                cache_creation = usage.get("cache_creation_input_tokens", 0)
                total_input = input_tokens + cache_read + cache_creation
                hit_rate = round(cache_read / total_input * 100, 2) if total_input else 0
                content = body.get("content", [])
                text_parts = [b.get("text", "") for b in content if b.get("type") == "text"]
                assistant_text = " ".join(text_parts)[:500]
                result["turns"].append({
                    "turn": i, "status": 200, "elapsed_s": round(elapsed, 2),
                    "input_tokens": input_tokens, "output_tokens": output_tokens,
                    "cache_read_input_tokens": cache_read, "cache_creation_input_tokens": cache_creation,
                    "total_input_tokens": total_input, "cache_hit_rate_pct": hit_rate,
                })
                print(f"      T{i}: {elapsed:.1f}s — input={input_tokens}, cache_read={cache_read}, hit={hit_rate}%")
                messages.append({"role": "assistant", "content": assistant_text})
            else:
                print(f"      T{i}: HTTP {resp.status_code} — {resp.text[:200]}")
                result["turns"].append({"turn": i, "status": resp.status_code, "elapsed_s": round(elapsed, 2), "error": resp.text[:1000]})
                messages.pop()
        except Exception as e:
            print(f"      T{i}: Exception — {e}")
            result["turns"].append({"turn": i, "status": "exception", "elapsed_s": round(time.time() - t0, 2), "error": str(e)})
            messages.pop()
        if i < len(descriptions):
            time.sleep(1)
    return result


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def session1_flash_sequential_images(images: list) -> list[dict]:
    """1 image per message, N messages, on both paths. umans-flash."""
    n = len(images)
    sid = str(uuid.uuid4())
    print("\n" + "=" * 70)
    print(f"SESSION 1: umans-flash — 1 image per message, {n} sequential messages")
    print("=" * 70)
    ts = datetime.now(timezone.utc).isoformat()
    with httpx.Client() as client:
        r_openai = run_openai_sequential_images(client, "umans-flash", images, "1a-openai", sid)
        r_anthropic = run_anthropic_sequential_images(client, "umans-flash", images, "1b-anthropic", sid)
    return [
        {"session": "1a-flash-seq-images-openai", "model": "umans-flash", "endpoint": "/v1/chat/completions",
         "strategy": f"sequential 1 image/message × {n}", "timestamp": ts, "turns": r_openai["turns"]},
        {"session": "1b-flash-seq-images-anthropic", "model": "umans-flash", "endpoint": "/v1/messages",
         "strategy": f"sequential 1 image/message × {n}", "timestamp": ts, "turns": r_anthropic["turns"]},
    ]


def session2_flash_sequential_text(images: list) -> list[dict]:
    """Flash handoff → N sequential text messages, on both paths. umans-flash conversation model."""
    n = len(images)
    sid = str(uuid.uuid4())
    print("\n" + "=" * 70)
    print(f"SESSION 2: umans-flash — flash handoff, 1 text description/message × {n}")
    print("=" * 70)
    ts = datetime.now(timezone.utc).isoformat()
    print("  Phase A: Flash handoff (1 image → 1 description)...")
    descriptions = []
    with httpx.Client() as client:
        for i, (name, data, mime) in enumerate(images, 1):
            d = flash_describe_image(client, name, data, mime, i, n, sid)
            descriptions.append(d)
        r_openai = run_openai_sequential_text(client, "umans-flash", descriptions, "2a-openai", sid)
        r_anthropic = run_anthropic_sequential_text(client, "umans-flash", descriptions, "2b-anthropic", sid)
    return [
        {"session": "2a-flash-seq-text-openai", "model": "umans-flash", "endpoint": "/v1/chat/completions",
         "strategy": f"flash handoff → sequential 1 text/message × {n}",
         "timestamp": ts, "handoff_model": "umans-flash", "handoff_descriptions": descriptions,
         "turns": r_openai["turns"]},
        {"session": "2b-flash-seq-text-anthropic", "model": "umans-flash", "endpoint": "/v1/messages",
         "strategy": f"flash handoff → sequential 1 text/message × {n}",
         "timestamp": ts, "handoff_model": "umans-flash", "handoff_descriptions": descriptions,
         "turns": r_anthropic["turns"]},
    ]


def session3_glm_sequential_images(images: list) -> list[dict]:
    """glm-5.2 server-side handoff, 1 image per message, Anthropic only."""
    n = len(images)
    sid = str(uuid.uuid4())
    print("\n" + "=" * 70)
    print(f"SESSION 3: glm-5.2 — server handoff, 1 image/message × {n} (Anthropic only)")
    print("=" * 70)
    ts = datetime.now(timezone.utc).isoformat()
    with httpx.Client() as client:
        r = run_anthropic_sequential_images(client, "umans-glm-5.2", images, "3-anthropic", sid)
    return [{"session": "3-glm-seq-images-anthropic", "model": "umans-glm-5.2", "endpoint": "/v1/messages",
             "strategy": f"server-side handoff, sequential 1 image/message × {n}",
             "timestamp": ts, "turns": r["turns"]}]


def session4_glm_sequential_text(images: list) -> list[dict]:
    """glm-5.2 flash handoff → N sequential text messages, both paths."""
    n = len(images)
    sid = str(uuid.uuid4())
    print("\n" + "=" * 70)
    print(f"SESSION 4: glm-5.2 — flash handoff, 1 text description/message × {n} (both paths)")
    print("=" * 70)
    ts = datetime.now(timezone.utc).isoformat()
    print("  Phase A: Flash handoff (1 image → 1 description)...")
    descriptions = []
    with httpx.Client() as client:
        for i, (name, data, mime) in enumerate(images, 1):
            d = flash_describe_image(client, name, data, mime, i, n, sid)
            descriptions.append(d)
        r_openai = run_openai_sequential_text(client, "umans-glm-5.2", descriptions, "4a-openai", sid)
        r_anthropic = run_anthropic_sequential_text(client, "umans-glm-5.2", descriptions, "4b-anthropic", sid)
    return [
        {"session": "4a-glm-seq-text-openai", "model": "umans-glm-5.2", "endpoint": "/v1/chat/completions",
         "strategy": f"flash handoff → sequential 1 text/message × {n}",
         "timestamp": ts, "handoff_model": "umans-flash", "handoff_descriptions": descriptions,
         "turns": r_openai["turns"]},
        {"session": "4b-glm-seq-text-anthropic", "model": "umans-glm-5.2", "endpoint": "/v1/messages",
         "strategy": f"flash handoff → sequential 1 text/message × {n}",
         "timestamp": ts, "handoff_model": "umans-flash", "handoff_descriptions": descriptions,
         "turns": r_anthropic["turns"]},
    ]


SESSION_FUNCS = {
    "1": session1_flash_sequential_images,
    "2": session2_flash_sequential_text,
    "3": session3_glm_sequential_images,
    "4": session4_glm_sequential_text,
}


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------


def compute_aggregate(turns: list[dict]) -> tuple[float, str]:
    valid = [t for t in turns if "cache_hit_rate_pct" in t]
    if not valid:
        if turns and turns[0].get("status"):
            return 0.0, f"ERR ({turns[0].get('status', '?')})"
        return 0.0, "—"
    total_cached = sum(t.get("cached_tokens", 0) or t.get("cache_read_input_tokens", 0) for t in valid)
    total_input = sum(t.get("prompt_tokens", 0) or t.get("total_input_tokens", 0) for t in valid)
    if not total_input:
        return 0.0, "0%"
    pct = round(total_cached / total_input * 100, 2)
    return pct, f"**{pct}%**"


def generate_report(results: list[dict]) -> str:
    lines: list[str] = []
    n_turns = max((len(r.get("turns", [])) for r in results), default=0)
    lines.append("# KV Cache Hit Rate Benchmark — Sequential Conversation")
    lines.append("")
    lines.append(f"**Date:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}")
    lines.append(f"**API:** `{API_BASE}`")
    lines.append(f"**API Key:** `{API_KEY[:8]}...{API_KEY[-4:]}`")
    lines.append(f"**Images tested:** {n_turns} per session (from `~/umans-gate/.omo/`)")
    lines.append(f"**Test runs:** {len(results)}")
    lines.append(f"**Timeout:** {TIMEOUT}s (3 min) per request")
    lines.append(f"**Conversation shape:** 1 conversation, {n_turns} sequential user messages (1 image or 1 text per message)")
    lines.append("")
    lines.append("## Methodology")
    lines.append("")
    lines.append(f"- ONE conversation per session, {n_turns} sequential user messages.")
    lines.append("- Each message carries 1 image (direct) or 1 text description (handoff).")
    lines.append("- Assistant response appended after each turn → conversation grows → KV cache warms up.")
    lines.append(f"- Measure cache hit rate on EACH turn, with focus on the last (T{n_turns}) response.")
    lines.append("- Flash handoff: `reasoning: {type: none}` + `max_tokens: 512` to avoid null content.")
    lines.append("- `top_k: -1` added to every request body (required by glm-5.2).")
    lines.append("")
    lines.append("Cache metric sources:")
    lines.append("- `/v1/chat/completions`: `usage.prompt_tokens_details.cached_tokens`")
    lines.append("- `/v1/messages`: `usage.cache_read_input_tokens`")
    lines.append("")

    # Summary table — all turns
    lines.append("## Summary — KV Cache Hit Rate per Turn (all sessions)")
    lines.append("")
    turn_headers = " | ".join(f"T{i+1}" for i in range(n_turns))
    turn_seps = " | ".join("---" for _ in range(n_turns))
    lines.append(f"| Session | Model | Endpoint | {turn_headers} | Aggregate |")
    lines.append(f"|---------|-------|----------|{turn_seps} |-----------|")
    for r in results:
        turns = r.get("turns", [])
        cells = []
        for t in turns:
            if "cache_hit_rate_pct" in t:
                cells.append(f"{t['cache_hit_rate_pct']}%")
            else:
                cells.append(f"ERR{t.get('status', '?')}")
        while len(cells) < n_turns:
            cells.append("—")
        _, agg_str = compute_aggregate(turns)
        row = f"| {r['session']} | `{r['model']}` | `{r['endpoint']}` | " + " | ".join(cells) + f" | {agg_str} |"
        lines.append(row)
    lines.append("")

    # Last-turn highlight
    lines.append(f"## KV Cache Hit Rate on LAST turn (T{n_turns})")
    lines.append("")
    lines.append("| Session | Model | Endpoint | Last Turn Hit Rate | Last Turn Tokens | Last Turn Cached |")
    lines.append("|---------|-------|----------|-------------------|------------------|------------------|")
    for r in results:
        turns = r.get("turns", [])
        last = turns[-1] if turns else {}
        if "cache_hit_rate_pct" in last:
            hit = f"{last['cache_hit_rate_pct']}%"
            total = last.get("prompt_tokens", 0) or last.get("total_input_tokens", 0)
            cached = last.get("cached_tokens", 0) or last.get("cache_read_input_tokens", 0)
        else:
            hit = f"ERR ({last.get('status', '?')})"
            total = "—"
            cached = "—"
        lines.append(f"| {r['session']} | `{r['model']}` | `{r['endpoint']}` | {hit} | {total} | {cached} |")
    lines.append("")

    # Details
    lines.append("## Session Details")
    lines.append("")
    for r in results:
        lines.append(f"### {r['session']}")
        lines.append(f"- **Model:** `{r['model']}`")
        lines.append(f"- **Endpoint:** `{r['endpoint']}`")
        lines.append(f"- **Strategy:** {r.get('strategy', '—')}")
        lines.append(f"- **Timestamp:** {r.get('timestamp', '—')}")
        turns = r.get("turns", [])
        if turns:
            lines.append("")
            lines.append("| Turn | Status | Elapsed | Prompt/Total Input | Cached | Hit Rate |")
            lines.append("|------|--------|---------|-------------------|--------|----------|")
            for t in turns:
                total = t.get("prompt_tokens", t.get("total_input_tokens", "—"))
                cached = t.get("cached_tokens", t.get("cache_read_input_tokens", "—"))
                hit = f"{t['cache_hit_rate_pct']}%" if "cache_hit_rate_pct" in t else f"ERR ({t.get('status', '?')})"
                lines.append(f"| {t.get('turn', '?')} | {t.get('status', '?')} | {t.get('elapsed_s', '—')}s | {total} | {cached} | {hit} |")
        lines.append("")

        if r.get("handoff_descriptions"):
            lines.append("#### Handoff Phase (image → text via umans-flash)")
            lines.append("")
            lines.append("| # | Image | Description | Elapsed | Tokens | Status |")
            lines.append("|---|-------|-------------|---------|--------|--------|")
            for i, h in enumerate(r["handoff_descriptions"], 1):
                desc_short = h.get("description", "—")[:120].replace("|", "\\|").replace("\n", " ")
                lines.append(f"| {i} | {h['filename']} | {desc_short} | {h.get('elapsed_s', '—')}s | {h.get('tokens', '—')} | {h.get('status', '—')} |")
            lines.append("")
        lines.append("")

    lines.append("## Key Findings")
    lines.append("")
    lines.append(f"- **Sequential conversation design**: 1 conversation, {n_turns} messages, 1 image/text per message. KV cache warms as conversation grows.")
    lines.append("- **Session 1** (flash direct images): Tests whether 1 image per request avoids the 10-image limit. Measures cache warming on umans-flash.")
    lines.append("- **Session 2** (flash handoff → text): Flash converts each image to text, then sequential text messages on umans-flash. No image limit applies.")
    lines.append("- **Session 3** (glm server handoff): glm-5.2 via /v1/messages, 1 image per message. OpenAI path skipped (no vision).")
    lines.append("- **Session 4** (glm flash handoff → text): Flash converts images, sequential text messages on glm-5.2. Both paths.")
    lines.append(f"- **Focus metric**: KV cache hit rate on the LAST (T{n_turns}) turn — this is where the cache is warmest and the benefit is maximal.")
    lines.append("- **`top_k: -1`** added to all request bodies (OpenAI + Anthropic paths) — required by glm-5.2 to avoid errors.")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(f"*Benchmark harness: `benchmark/vision-handoff/benchmark.py`*")
    lines.append(f"*Run: `{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}`*")
    return "\n".join(lines)


def save_results(results: list[dict], run_id: str, final: bool = False):
    """Save JSON + markdown report. If not final, prefix with _partial."""
    suffix = "" if final else "_partial"
    json_path = BENCH_DIR / f"vision_handoff_{run_id}{suffix}.json"
    json_path.write_text(json.dumps(results, indent=2, ensure_ascii=False))
    report = generate_report(results)
    report_path = BENCH_DIR / f"vision_handoff_report_{run_id}{suffix}.md"
    report_path.write_text(report)
    if final:
        (BENCH_DIR / "vision_handoff_report_latest.md").write_text(report)
        (BENCH_DIR / "vision_handoff_latest.json").write_text(json.dumps(results, indent=2, ensure_ascii=False))
    return json_path, report_path


def run_session(session_num: str, images: list) -> list[dict]:
    """Run a single session in its own httpx client (thread-safe)."""
    func = SESSION_FUNCS[session_num]
    return func(images)


def main():
    parser = argparse.ArgumentParser(description="Vision handoff KV cache benchmark")
    parser.add_argument("--images", type=int, default=11, help="Number of images/turns (default: 11)")
    parser.add_argument("--sessions", type=str, default="1,2,3,4", help="Comma-separated session numbers to run (default: 1,2,3,4)")
    parser.add_argument("--workers", type=int, default=2, help="Number of parallel session workers (default: 2)")
    args = parser.parse_args()
    n_images = args.images
    sessions_to_run = sorted(set(s.strip() for s in args.sessions.split(",")))
    workers = args.workers

    print("=" * 70)
    print(f"Vision Handoff Benchmark — Sequential ({n_images} turns)")
    print("=" * 70)
    print(f"API: {API_BASE}")
    print(f"Key: {API_KEY[:8]}...{API_KEY[-4:]}")
    print(f"Timeout: {TIMEOUT}s per request")
    print(f"Sessions to run: {sessions_to_run}")
    print(f"Parallel workers: {workers}")
    print(f"Output dir: {BENCH_DIR}")
    print()

    images = load_images(n_images)
    print(f"Loaded {len(images)} images:")
    for name, _, mime in images:
        print(f"  - {name} ({mime})")

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    results: list[dict] = []

    # Run sessions in parallel (each session owns its own httpx.Client)
    if workers > 1 and len(sessions_to_run) > 1:
        print(f"\n>>> Running {len(sessions_to_run)} sessions in parallel ({workers} workers)...")
        with ThreadPoolExecutor(max_workers=workers) as executor:
            future_to_session = {
                executor.submit(run_session, s, images): s for s in sessions_to_run
            }
            session_results: dict[str, list[dict]] = {}
            for future in as_completed(future_to_session):
                s = future_to_session[future]
                try:
                    session_results[s] = future.result()
                    print(f"\n>>> Session {s} done. ({len(session_results[s])} runs)")
                    # Save partial results after each session completes
                    partial = []
                    for snum in sorted(session_results.keys()):
                        partial.extend(session_results[snum])
                    save_results(partial, run_id, final=False)
                except Exception as e:
                    print(f"\n>>> Session {s} FAILED: {e}")
                    session_results[s] = []
        # Assemble final results in session order
        for s in sessions_to_run:
            results.extend(session_results.get(s, []))
    else:
        # Sequential mode
        with httpx.Client() as client:
            for s in sessions_to_run:
                print(f"\n>>> Starting Session {s}...")
                sr = SESSION_FUNCS[s](images)
                results.extend(sr)
                save_results(results, run_id, final=False)
                print(f">>> Session {s} done. Partial results saved. ({len(sr)} runs)")

    json_path, report_path = save_results(results, run_id, final=True)
    report = (BENCH_DIR / "vision_handoff_report_latest.md").read_text()

    print(f"\n{'=' * 70}")
    print(f"JSON: {json_path}")
    print(f"Report: {report_path}")
    print(f"Latest: {BENCH_DIR / 'vision_handoff_report_latest.md'}")
    print(f"{'=' * 70}")
    print()
    print(report)


if __name__ == "__main__":
    main()
