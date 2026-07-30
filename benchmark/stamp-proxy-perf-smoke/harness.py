#!/usr/bin/env python3
"""
Stamp Proxy Performance Benchmark — SMOKE TEST (Python, pi CLI)
==============================================================
Trimmed version: 3 models x 2 paths x 3 turns x 2 passes = 36 requests.
~15-20 min runtime (pi is lighter than OpenCode — ~12k token prefix vs ~50k).

Measures the impact of stamp_claude_code_enabled (TTL stamping) on:
  - Cache hit rate (cache_read_tokens / total_input_tokens * 100)
  - Cache write cost (cache_creation_tokens)
  - TTFT (time-to-first-token, ms)
  - TPS (tokens per second)
  - Token breakdown (uncached input, cached input, cache write, output, thinking)
  - Duration (end-to-end, ms)

Harness: pi CLI (v0.83.0+) — non-interactive via --print --mode json.
  - pi --print --mode json --model <provider/model> "prompt"  (turn 1)
  - pi --print --mode json --model <provider/model> --session-id <id> "prompt"  (turns 2+)
  - Output: NDJSON with {"type":"session","id":"<uuid>"} for session ID extraction
  - Token usage in {"type":"message_end"} events: usage.input, usage.cacheRead, etc.

Provider routing (from ~/.pi/agent/models.json):
  - pi "umans/..."          → openai-completions API → /v1/chat/completions (OpenAI path)
  - pi "umans-anthropic/..." → anthropic-messages API → /v1/messages (Anthropic path)

USAGE:
  python3 -u benchmark/stamp-proxy-perf-smoke/harness.py            # full smoke
  python3 -u benchmark/stamp-proxy-perf-smoke/harness.py --dry-run  # print plan
  python3 -u benchmark/stamp-proxy-perf-smoke/harness.py --pass a   # only pass A
  python3 -u benchmark/stamp-proxy-perf-smoke/harness.py --pass b   # only pass B
  python3 -u benchmark/stamp-proxy-perf-smoke/harness.py --collect  # print SQL

SAFETY:
  Waits for active requests to reach zero before config toggle.
  Uses explicit /config/reload after save. If active never reaches 0
  (live session traffic), warns and proceeds after 5s — toggle is safe
  between requests (stamp config read once per request).

DATA:
  All metrics are plain numeric columns in ~/umans-gate.db (captures table).
  No decompression needed — zstd body/header columns are NOT read.
  Hit rate formula: cache_read_tokens / total_input_tokens * 100 (percentage).
  Aggregate hit rate: SUM(cache_read) / SUM(total_input) — never AVG(per_turn).
"""

import argparse
import csv
import json
import os
import sqlite3
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone

import requests

# Thread-safe print — parallel cells emit interleaved log lines without this.
_print_lock = threading.Lock()

def tprint(*args, **kwargs):
    with _print_lock:
        print(*args, **kwargs)

PROXY_BASE = "http://localhost:1945"
CONFIG_API = f"{PROXY_BASE}/dashboard/api/config"
GATE_API = f"{PROXY_BASE}/dashboard/api/gate"
DB_PATH = os.environ.get("UMANS_GATE_DB", os.path.expanduser("~/umans-gate.db"))
DB_DISPLAY = os.environ.get("UMANS_GATE_DB", "~/umans-gate.db")

CAPTURE_POLL_INTERVAL = 0.5
CAPTURE_POLL_TIMEOUT = 120.0
CONFIG_SETTLE = 3.0
ACTIVE_POLL_INTERVAL = 0.5
ACTIVE_ZERO_CONFIRM = 2.0
ACTIVE_WAIT_TIMEOUT = 30.0
TURN_TIMEOUT = None  # no timeout — let pi complete naturally
INTER_TURN_DELAY = 2.0
INTER_PASS_WAIT = 5 * 60  # 5 min (pass A uses 5m TTL → 5 min guarantees expiry)

TURNS_PER_CELL = 3

# Pass configs — what we toggle for each pass.
# stamp_model_rules (ADR-0020 PerModelRuleStep) is INDEPENDENT of
# stamp_claude_code_enabled. It fires whenever a matching rule exists,
# regardless of the master toggle (src/stamp-pipeline.ts:187-190). It mutates
# thinking shapes on BOTH paths → dirty baseline. Must set [] in pass A.
# Experiment flags also run independently and mutate request bodies.
# All must be false in pass A.
# Pass B = full production config (everything user had ON), built at runtime.
PASS_CONFIGS = {
    "a": {
        "stamp_claude_code_enabled": False,
        "stamp_reasoning_effort_enabled": False,
        "stamp_model_rules": [],
        "experiment_rewrite_ids": False,
        "experiment_strip_omo_reminder": False,
        "experiment_ttft_watchdog": False,
    },
    "b": None,  # populated from saved config at runtime
}

SAVED_CONFIG_FIELDS = [
    "stamp_claude_code_enabled",
    "stamp_reasoning_effort_enabled",
    "stamp_model_rules",
    "experiment_rewrite_ids",
    "experiment_strip_omo_reminder",
    "experiment_ttft_watchdog",
]

# Provider mapping for pi CLI:
#   pi "umans/..."           → openai-completions  → /v1/chat/completions (OpenAI path)
#   pi "umans-anthropic/..." → anthropic-messages  → /v1/messages (Anthropic path)
CELLS = [
    {"model": "umans-coder",   "path": "anthropic", "provider": "umans-anthropic/umans-coder"},
    {"model": "umans-coder",   "path": "openai",    "provider": "umans/umans-coder"},
    {"model": "umans-flash",   "path": "openai",    "provider": "umans/umans-flash"},
    {"model": "umans-glm-5.2", "path": "anthropic", "provider": "umans-anthropic/umans-glm-5.2"},
    {"model": "umans-glm-5.2", "path": "openai",    "provider": "umans/umans-glm-5.2"},
]

PROMPTS = [
    "Session {SESSION_TAG}: In one paragraph, what is Anthropic prompt caching and how does the ttl field on a cache_control ephemeral block affect it? Answer from general knowledge, do not read any files.",
    "Following up: if two sessions share the same system prompt but different first user messages, will the second session hit the first's cache? Explain in 3 sentences.",
    "Following up: in a 10-turn conversation, at which turn does cache hit rate typically stabilize and why? Answer in 2 sentences.",
]

PROMPTS = [
    "Session {SESSION_TAG}: In one paragraph, what is Anthropic prompt caching and how does the ttl field on a cache_control ephemeral block affect it? Answer from general knowledge, do not read any files.",
    "Following up: if two sessions share the same system prompt but different first user messages, will the second session hit the first's cache? Explain in 3 sentences.",
    "Following up: in a 10-turn conversation, at which turn does cache hit rate typically stabilize and why? Answer in 2 sentences.",
]


def path_string(p):
    return "/v1/messages" if p == "anthropic" else "/v1/chat/completions"


# ---------------------------------------------------------------------------
# Config toggle
# ---------------------------------------------------------------------------

def get_dashboard_token():
    try:
        r = requests.get(CONFIG_API, timeout=5)
        r.raise_for_status()
        return r.json().get("dashboard_token") or None
    except Exception:
        return None


def check_ring_buffer(token):
    """Warn if max_captures is too small for the benchmark + live traffic."""
    try:
        r = requests.get(CONFIG_API, headers=auth_headers(token), timeout=5)
        r.raise_for_status()
        cfg = r.json()
        max_captures = cfg.get("max_captures", 200)
        total_benchmark = len(CELLS) * TURNS_PER_CELL * 2  # 2 passes
        if max_captures < total_benchmark + 50:
            print(f"  [WARN] max_captures={max_captures} may be too small for "
                  f"{total_benchmark} benchmark captures + live traffic. "
                  f"Consider raising to {total_benchmark + 100}+ (requires restart).")
        else:
            print(f"  [ring-buffer] max_captures={max_captures}, benchmark needs ~{total_benchmark} — OK")
    except Exception as e:
        print(f"  [WARN] Could not check max_captures: {e}")


def auth_headers(token):
    h = {"Content-Type": "application/json"}
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def get_active_count(token):
    r = requests.get(GATE_API, headers=auth_headers(token), timeout=5)
    r.raise_for_status()
    return r.json().get("active", 0)


def wait_for_quiet(token):
    deadline = time.time() + ACTIVE_WAIT_TIMEOUT
    zero_since = None
    last_active = -1
    while time.time() < deadline:
        try:
            active = get_active_count(token)
        except Exception as e:
            raise RuntimeError(f"wait_for_quiet: failed to fetch gate stats: {e}")
        last_active = active
        if active == 0:
            if zero_since is None:
                zero_since = time.time()
            if time.time() - zero_since >= ACTIVE_ZERO_CONFIRM:
                return
        else:
            zero_since = None
        time.sleep(ACTIVE_POLL_INTERVAL)
    print(f"  [config] wait_for_quiet timed out (active={last_active}). "
          f"Likely live session traffic. Proceeding — toggle safe between requests.")
    time.sleep(5)


def set_pass_config(pas, token):
    cfg = PASS_CONFIGS[pas]
    print(f"\n[config] Setting pass {pas.upper()}: {cfg}")

    wait_for_quiet(token)

    r = requests.post(CONFIG_API, headers=auth_headers(token), json=cfg, timeout=10)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"Config save failed: {data.get('errors')}")

    r = requests.post(f"{CONFIG_API}/reload", headers=auth_headers(token), timeout=10)
    data = r.json()
    if not data.get("ok"):
        raise RuntimeError(f"Config reload failed: {data.get('errors')}")

    applied = data.get("applied", [])
    for key in cfg:
        if key not in applied:
            print(f"  [config] WARNING: {key} not in applied list")

    r = requests.get(CONFIG_API, headers=auth_headers(token), timeout=5)
    confirmed = r.json()
    for key, want in cfg.items():
        got = confirmed.get(key)
        if got != want:
            raise RuntimeError(f"Config confirmation failed: {key}={got} (want {want})")

    print("[config] Saved + reloaded + confirmed. Waiting for settle...")
    time.sleep(CONFIG_SETTLE)


def save_original_config(token):
    r = requests.get(CONFIG_API, headers=auth_headers(token), timeout=5)
    r.raise_for_status()
    cfg = r.json()
    saved = {}
    for field in SAVED_CONFIG_FIELDS:
        saved[field] = cfg.get(field)
    print(f"[config] Saved original config: {saved}")
    return saved


def restore_config(saved, token):
    print(f"\n[config] Restoring original config...")
    wait_for_quiet(token)
    r = requests.post(CONFIG_API, headers=auth_headers(token), json=saved, timeout=10)
    data = r.json()
    if not data.get("ok"):
        print(f"  [config] WARNING: restore save failed: {data.get('errors')}")
        return
    r = requests.post(f"{CONFIG_API}/reload", headers=auth_headers(token), timeout=10)
    data = r.json()
    if not data.get("ok"):
        print(f"  [config] WARNING: restore reload failed: {data.get('errors')}")
        return
    print("[config] Original config restored.")


# ---------------------------------------------------------------------------
# pi CLI runner
# ---------------------------------------------------------------------------

def run_pi_turn(provider, prompt, session_id=None):
    args = ["pi", "--print", "--mode", "json", "--model", provider, "--thinking", "max"]
    if session_id:
        args.extend(["--session-id", session_id])
    args.append(prompt)

    try:
        result = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=TURN_TIMEOUT,
        )
        if result.returncode != 0:
            err = result.stderr[:500] if result.stderr else ""
            return {"session_id": None, "raw": result.stdout, "error": f"pi exit {result.returncode}: {err}"}

        found_sid = None
        for line in result.stdout.split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                evt = json.loads(line)
                if evt.get("type") == "session" and evt.get("id"):
                    found_sid = evt["id"]
                    break
            except json.JSONDecodeError:
                continue

        return {"session_id": found_sid, "raw": result.stdout, "error": None}

    except subprocess.TimeoutExpired:
        return {"session_id": None, "raw": "", "error": f"pi timed out after {TURN_TIMEOUT}s"}
    except Exception as e:
        return {"session_id": None, "raw": "", "error": str(e)}


# ---------------------------------------------------------------------------
# Capture collection
# ---------------------------------------------------------------------------

def find_capture(model, path_str, before_ms, after_ms):
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            """SELECT id, model, path, started_at, state,
                      input_tokens, cache_creation_tokens, cache_read_tokens,
                      total_input_tokens, total_output_tokens, thinking_tokens,
                      ttft_ms, tps, duration_ms, usage_missing
               FROM captures
               WHERE model = ? AND path = ?
                 AND started_at >= ? AND started_at <= ?
                 AND is_vision = 0 AND state = 'done'
                 AND usage_missing = 0
               ORDER BY started_at DESC LIMIT 1""",
            (model, path_str, before_ms, after_ms + 120_000),
        ).fetchone()
        return dict(row) if row else None
    except sqlite3.OperationalError as e:
        if "database is locked" in str(e):
            return None
        raise
    finally:
        conn.close()


def wait_for_capture(model, path_str, before_ms, after_ms):
    deadline = time.time() + CAPTURE_POLL_TIMEOUT
    while time.time() < deadline:
        try:
            row = find_capture(model, path_str, before_ms, after_ms)
            if row:
                return row
        except sqlite3.OperationalError:
            pass
        time.sleep(CAPTURE_POLL_INTERVAL)
    return None


def row_to_turn_result(row, turn, session_id, error):
    if not row:
        return {
            "turn": turn, "capture_id": None, "session_id": session_id,
            "input_tokens": None, "cache_read": None, "cache_creation": None,
            "total_input": None, "total_output": None, "thinking_tokens": None,
            "ttft_ms": None, "tps": None, "duration_ms": None,
            "hit_rate": None, "error": error,
        }
    total_input = row.get("total_input_tokens") or 0
    cache_read = row.get("cache_read_tokens") or 0
    hit_rate = round(100.0 * cache_read / total_input, 2) if total_input > 0 else None
    return {
        "turn": turn, "capture_id": row["id"], "session_id": session_id,
        "input_tokens": row.get("input_tokens"),
        "cache_read": cache_read,
        "cache_creation": row.get("cache_creation_tokens"),
        "total_input": total_input,
        "total_output": row.get("total_output_tokens"),
        "thinking_tokens": row.get("thinking_tokens"),
        "ttft_ms": row.get("ttft_ms"),
        "tps": row.get("tps"),
        "duration_ms": row.get("duration_ms"),
        "hit_rate": hit_rate, "error": error,
    }


# ---------------------------------------------------------------------------
# Main benchmark loop
# ---------------------------------------------------------------------------

def run_cell(cell, pas, token):
    session_tag = f"{pas}-{cell['model']}-{cell['path']}-{int(time.time()*1000):x}"
    tprint(f"\n  [cell] {cell['model']} / {cell['path']} (tag: {session_tag})")

    turns = []
    session_id = None

    for t in range(TURNS_PER_CELL):
        turn_num = t + 1
        prompt = PROMPTS[t].replace("{SESSION_TAG}", session_tag)
        before_ms = int(time.time() * 1000)
        tprint(f"    [{cell['model']}/{cell['path']} turn {turn_num}/{TURNS_PER_CELL}] sending...")

        result = run_pi_turn(cell["provider"], prompt, session_id)
        session_id = result["session_id"] or session_id

        if result["error"]:
            tprint(f"    [{cell['model']}/{cell['path']} turn {turn_num}] pi error, retrying once...")
            time.sleep(3)
            result = run_pi_turn(cell["provider"], prompt, session_id)
            session_id = result["session_id"] or session_id

        if result["error"]:
            tprint(f"    [{cell['model']}/{cell['path']} turn {turn_num}] retry failed, aborting cell: {result['error']}")
            for rt in range(turn_num, TURNS_PER_CELL + 1):
                turns.append(row_to_turn_result(None, rt, session_id, f"aborted: turn {turn_num} failed"))
            break

        after_ms = int(time.time() * 1000)
        p_str = path_string(cell["path"])
        cap_row = wait_for_capture(cell["model"], p_str, before_ms, after_ms)
        turn_result = row_to_turn_result(
            cap_row, turn_num, session_id,
            None if cap_row else "capture not found in DB",
        )

        if turn_num == 1 and turn_result["cache_read"] and turn_result["cache_read"] > 0:
            tprint(f"    [{cell['model']}/{cell['path']} turn 1] WARNING: cache_read={turn_result['cache_read']} on cold turn — contamination!")

        turns.append(turn_result)

        hit_str = f"{turn_result['hit_rate']}%" if turn_result["hit_rate"] is not None else "n/a"
        read_str = turn_result["cache_read"] if turn_result["cache_read"] is not None else "?"
        input_str = turn_result["total_input"] if turn_result["total_input"] is not None else "?"
        tprint(
            f"    [{cell['model']}/{cell['path']} turn {turn_num}] capture={turn_result['capture_id']} "
            f"hit={hit_str} cache_read={read_str} input={input_str} "
            f"ttft={turn_result['ttft_ms'] or '?'}ms"
        )

        time.sleep(INTER_TURN_DELAY)

    return {"pass": pas, "model": cell["model"], "path": cell["path"], "turns": turns}


def run_pass(pas, token, workers=6):
    cfg = PASS_CONFIGS[pas]
    label = "STAMPED" if cfg["stamp_claude_code_enabled"] else "BASELINE"
    tprint(f"\n{'='*70}")
    tprint(f"PASS {pas.upper()}: {label} (SMOKE)")
    tprint(f"  stamp_claude_code_enabled: {cfg['stamp_claude_code_enabled']}")
    tprint(f"  stamp_reasoning_effort_enabled: {cfg['stamp_reasoning_effort_enabled']}")
    tprint(f"  workers: {workers} (parallel cells)")
    tprint(f"{'='*70}")

    set_pass_config(pas, token)

    if workers <= 1:
        results = []
        for cell in CELLS:
            result = run_cell(cell, pas, token)
            results.append(result)
        return results

    results: list[dict] = [{} for _ in CELLS]
    with ThreadPoolExecutor(max_workers=workers) as executor:
        future_to_idx = {
            executor.submit(run_cell, cell, pas, token): i
            for i, cell in enumerate(CELLS)
        }
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            try:
                results[idx] = future.result()
            except Exception as e:
                tprint(f"  [cell {idx}] EXCEPTION: {e}")
                results[idx] = {
                    "pass": pas, "model": CELLS[idx]["model"],
                    "path": CELLS[idx]["path"], "turns": [],
                }
    return results


# ---------------------------------------------------------------------------
# Results output
# ---------------------------------------------------------------------------

def write_detail_csv(all_results, path):
    """Per-turn detail CSV — one row per request."""
    rows = []
    for cell in all_results:
        for turn in cell["turns"]:
            rows.append({
                "pass": cell["pass"], "model": cell["model"], "path": cell["path"],
                "turn": turn["turn"], "session_id": turn["session_id"],
                "capture_id": turn["capture_id"],
                "input_tokens": turn["input_tokens"],
                "cache_read_tokens": turn["cache_read"],
                "cache_creation_tokens": turn["cache_creation"],
                "total_input_tokens": turn["total_input"],
                "total_output_tokens": turn["total_output"],
                "thinking_tokens": turn["thinking_tokens"],
                "ttft_ms": turn["ttft_ms"], "tps": turn["tps"],
                "duration_ms": turn["duration_ms"],
                "hit_rate_pct": turn["hit_rate"],
                "error": turn["error"],
            })
    if not rows:
        return
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(f"[output] Wrote {len(rows)} detail rows to {path}")


def write_aggregate_csv(all_results, path):
    """Per-cell aggregate CSV — one row per model x path x pass.
    Uses SUM-based hit rate (never AVG of per-turn rates)."""
    rows = []
    for cell in all_results:
        valid = [t for t in cell["turns"] if t["hit_rate"] is not None]
        if not valid:
            rows.append({
                "pass": cell["pass"], "model": cell["model"], "path": cell["path"],
                "valid_turns": 0, "agg_hit_pct": None,
                "total_input": 0, "total_output": 0, "total_cached": 0,
                "total_uncached": 0, "total_cache_create": 0,
                "mean_ttft_ms": None, "median_ttft_ms": None,
                "min_ttft_ms": None, "max_ttft_ms": None,
                "mean_tps": None, "mean_duration_ms": None,
            })
            continue

        total_in = sum(t["total_input"] or 0 for t in valid)
        total_out = sum(t["total_output"] or 0 for t in valid)
        total_cached = sum(t["cache_read"] or 0 for t in valid)
        total_uncached = sum(t["input_tokens"] or 0 for t in valid)
        total_create = sum(t["cache_creation"] or 0 for t in valid)
        agg_hit = round(100.0 * total_cached / total_in, 2) if total_in > 0 else None

        ttft_vals = sorted([t["ttft_ms"] for t in valid if t["ttft_ms"] is not None])
        tps_vals = [t["tps"] for t in valid if t["tps"] is not None]
        dur_vals = [t["duration_ms"] for t in valid if t["duration_ms"] is not None]

        def median(lst):
            n = len(lst)
            if n == 0:
                return None
            mid = n // 2
            if n % 2 == 0:
                return round((lst[mid - 1] + lst[mid]) / 2, 1)
            return lst[mid]

        rows.append({
            "pass": cell["pass"], "model": cell["model"], "path": cell["path"],
            "valid_turns": len(valid),
            "agg_hit_pct": agg_hit,
            "total_input": total_in,
            "total_output": total_out,
            "total_cached": total_cached,
            "total_uncached": total_uncached,
            "total_cache_create": total_create,
            "mean_ttft_ms": round(sum(ttft_vals) / len(ttft_vals), 1) if ttft_vals else None,
            "median_ttft_ms": median(ttft_vals),
            "min_ttft_ms": ttft_vals[0] if ttft_vals else None,
            "max_ttft_ms": ttft_vals[-1] if ttft_vals else None,
            "mean_tps": round(sum(tps_vals) / len(tps_vals), 2) if tps_vals else None,
            "mean_duration_ms": round(sum(dur_vals) / len(dur_vals), 1) if dur_vals else None,
        })

    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=rows[0].keys())
        writer.writeheader()
        writer.writerows(rows)
    print(f"[output] Wrote {len(rows)} aggregate rows to {path}")


def print_summary(all_results):
    print(f"\n{'='*70}")
    print("STAMP PROXY PERF — SMOKE TEST SUMMARY")
    print(f"{'='*70}")
    for cell in all_results:
        valid = [t for t in cell["turns"] if t["hit_rate"] is not None]
        avg_hit = sum(t["hit_rate"] for t in valid) / len(valid) if valid else None
        first_hit = valid[0]["hit_rate"] if valid else None
        last_hit = valid[-1]["hit_rate"] if valid else None
        avg_ttft = sum(t["ttft_ms"] for t in valid if t["ttft_ms"]) / max(1, len([t for t in valid if t["ttft_ms"]]))
        avg_tps_vals = [t["tps"] for t in valid if t["tps"]]
        avg_tps = sum(avg_tps_vals) / len(avg_tps_vals) if avg_tps_vals else None
        total_in = sum(t["total_input"] or 0 for t in valid)
        total_out = sum(t["total_output"] or 0 for t in valid)
        total_cached = sum(t["cache_read"] or 0 for t in valid)
        total_uncached = sum(t["input_tokens"] or 0 for t in valid)
        agg_hit = round(100.0 * total_cached / total_in, 2) if total_in > 0 else None
        avg_str = f"{avg_hit:.1f}%" if avg_hit is not None else "n/a"
        agg_str = f"{agg_hit}%" if agg_hit is not None else "n/a"
        first_str = f"{first_hit}%" if first_hit is not None else "n/a"
        last_str = f"{last_hit}%" if last_hit is not None else "n/a"
        tps_str = f"{avg_tps:.1f}" if avg_tps is not None else "n/a"
        print(
            f"  {cell['pass'].upper()} {cell['model']}/{cell['path']}: "
            f"turn1={first_str} turnN={last_str} avg={avg_str} agg={agg_str} "
            f"ttft={avg_ttft:.0f}ms tps={tps_str} "
            f"in={total_in} out={total_out} cached={total_cached} uncached={total_uncached} "
            f"({len(valid)}/{TURNS_PER_CELL} valid)"
        )

    all_turns = [t for c in all_results for t in c["turns"]]
    errors = [t for t in all_turns if t["error"] is not None]
    missing = [t for t in errors if t["error"] == "capture not found in DB"]
    aborted = [t for t in errors if t["error"] and t["error"].startswith("aborted:")]

    print(f"\n  --- SMOKE VERDICT ---")
    print(f"  Total turns: {len(all_turns)}/{len(CELLS) * TURNS_PER_CELL * 2}")
    print(f"  Valid captures: {sum(1 for t in all_turns if t['capture_id'] is not None)}")
    print(f"  Missing captures: {len(missing)}")
    print(f"  Aborted: {len(aborted)}")

    if not missing and not aborted:
        print("  RESULT: PASS — harness works end-to-end. Safe to run full benchmark.")
    elif aborted:
        print("  RESULT: FAIL — cells aborted. Fix harness before full run.")
    else:
        print("  RESULT: WARN — some captures missing. Check DB path and timing.")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Stamp Proxy Perf Smoke Benchmark")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--pass", dest="only_pass", choices=["a", "b"])
    parser.add_argument("--collect", action="store_true")
    parser.add_argument("--workers", type=int, default=6,
                        help="Parallel cells per pass (default: 6 = all cells concurrent). "
                             "Use 1 for serial mode.")
    args = parser.parse_args()

    if args.collect:
        print("-- SMOKE collection SQL (run against ./umans-gate.db)")
        print("""SELECT model, path, COUNT(*) AS reqs,
  SUM(cache_read_tokens) AS cached, SUM(total_input_tokens) AS total_in,
  ROUND(100.0 * SUM(cache_read_tokens) / NULLIF(SUM(total_input_tokens), 0), 2) AS hit_pct
FROM captures
WHERE started_at >= strftime('%s', 'now', '-2 hours') * 1000
  AND is_vision = 0 AND state = 'done'
  AND model IN ('umans-coder', 'umans-flash', 'umans-glm-5.2')
GROUP BY model, path ORDER BY hit_pct DESC;""")
        return

    passes_list = [args.only_pass] if args.only_pass else ["a", "b"]
    total_reqs = len(passes_list) * len(CELLS) * TURNS_PER_CELL

    print("Stamp Proxy Performance Benchmark — SMOKE TEST (Python, pi CLI)")
    print(f"  Proxy: {PROXY_BASE}")
    print(f"  DB:    {DB_DISPLAY}")
    print(f"  Matrix: {len(CELLS)} cells x {TURNS_PER_CELL} turns = {len(CELLS) * TURNS_PER_CELL} requests per pass")
    print(f"  Passes: {' + '.join(p.upper() for p in passes_list)} = {total_reqs} total requests")
    print(f"  Inter-pass wait: {INTER_PASS_WAIT // 60} min")
    print(f"  Workers: {args.workers} ({'parallel' if args.workers > 1 else 'serial'})")
    if args.workers > 1:
        print(f"  Est. runtime: ~5-10 min (parallel, {args.workers}x speedup + inter-pass wait)")
    else:
        est = "10-15" if args.only_pass else "20-25"
        print(f"  Est. runtime: ~{est} min")

    if args.dry_run:
        print("\n[DRY RUN] Plan:")
        for pas in passes_list:
            if pas == "b":
                print(f"\n  Pass B: stamp=True (production config — built at runtime)")
            else:
                print(f"\n  Pass A: stamp=False (vanilla)")
            print(f"  Workers: {args.workers}")
            for cell in CELLS:
                print(f"    {cell['model']} / {cell['path']} ({cell['provider']}) — {TURNS_PER_CELL} turns")
        return

    token = get_dashboard_token()
    check_ring_buffer(token)
    saved_config = save_original_config(token)

    pass_b_cfg = {field: saved_config[field] for field in SAVED_CONFIG_FIELDS}
    pass_b_cfg["stamp_claude_code_enabled"] = True
    pass_b_cfg["stamp_reasoning_effort_enabled"] = True
    PASS_CONFIGS["b"] = pass_b_cfg
    print(f"[config] Pass B (production config): {pass_b_cfg}")

    all_results = []

    try:
        for pas in passes_list:
            results = run_pass(pas, token, workers=args.workers)
            all_results.extend(results)

            if pas == "a" and "b" in passes_list:
                print(f"\n[inter-pass] Waiting {INTER_PASS_WAIT // 60} min for cache expiry...")
                time.sleep(INTER_PASS_WAIT)
    finally:
        restore_config(saved_config, token)

    ts = datetime.now(timezone.utc).isoformat().replace(":", "-").replace(".", "-")
    detail_path = f"benchmark/stamp-proxy-perf-smoke/results/smoke-{ts}.csv"
    agg_path = f"benchmark/stamp-proxy-perf-smoke/results/smoke-{ts}-agg.csv"
    write_detail_csv(all_results, detail_path)
    write_aggregate_csv(all_results, agg_path)
    print_summary(all_results)
    print(f"\n[done] Smoke test complete.")
    print(f"  Detail:    {detail_path}")
    print(f"  Aggregate: {agg_path}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n[aborted] Interrupted by user.")
        sys.exit(1)
    except Exception as e:
        print(f"Fatal: {e}", file=sys.stderr)
        sys.exit(1)
