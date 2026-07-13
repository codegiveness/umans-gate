"""B7 — Prefix Stability: Proxy Does Not Break Upstream Cache.
Anthropic route, through proxy.
Proves: Multi-turn conversation through proxy maintains cache hit ratio > 0,
meaning the proxy doesn't inject noise that busts the upstream prompt cache.
"""

import json
import os
import statistics
import subprocess
import time
from capture_reader import (
    clear_captures,
    get_captures,
    get_config,
    set_config,
    wait_for_queue_drain,
)
from harness import _find_session_path
from metrics import cache_hit_ratio, ttft_stats, total_tokens

PROVIDER = "umans-proxy-anthropic"
MODEL = "umans-glm-5.2"
TURNS = 5
PI_PATH = os.path.expanduser("~/.bun/bin/pi")
PROMPTS = [
    "Explain the SRP principle from the AGENTS.md file.",
    "Now explain the OCP principle.",
    "Now explain the LSP principle.",
    "Now explain the ISP principle.",
    "Now explain the DIP principle.",
]


def _run_multi_turn(session_id: str) -> list[dict]:
    """Run a 5-turn conversation through the proxy, return captures."""
    for i in range(TURNS):
        cmd = [PI_PATH, "--print", "--provider", PROVIDER, "--model", MODEL, "--tools", "read"]
        if i == 0:
            cmd += ["--session-id", session_id]
        else:
            path = _find_session_path(session_id)
            if path:
                cmd += ["--session", path, "--continue"]
            else:
                cmd += ["--session-id", session_id]
        cmd += ["-p", PROMPTS[i]]
        subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    wait_for_queue_drain(timeout=60)
    return get_captures()


def run(iterations: int = 2) -> dict:
    results = []
    for i in range(iterations):
        print(f"  B7 iteration {i+1}/{iterations}")
        # Ensure stamping is ON (proxy is doing its job)
        set_config({"stamp_claude_code_enabled": True})
        clear_captures()
        caps = _run_multi_turn(f"bench-b7-{i}")
        ratio = cache_hit_ratio(caps)
        ttft = ttft_stats(caps)
        tokens = total_tokens(caps)
        results.append({
            "captures": len(caps),
            "cache_hit_ratio": ratio,
            "tokens": tokens,
            "ttft": ttft,
        })

    ratios = [r["cache_hit_ratio"] for r in results]
    median_ratio = statistics.median(ratios) if ratios else 0
    ttfts = [r["ttft"]["p50"] for r in results]
    median_ttft = statistics.median(ttfts) if ttfts else 0
    return {
        "benchmark": "B7 — Prefix Stability",
        "iterations": iterations,
        "results": results,
        "summary": {
            "cache_hit_ratio_median": median_ratio,
            "ttft_p50_median_ms": median_ttft,
            "pass": median_ratio > 0,
        },
    }


if __name__ == "__main__":
    import json
    import os

    result = run()
    results_dir = os.path.join(os.path.dirname(__file__), "..", "..", ".omo", "results")
    os.makedirs(results_dir, exist_ok=True)
    path = os.path.join(results_dir, "b7_result.json")
    with open(path, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"\nSaved to {path}")
    print(json.dumps(result, indent=2, default=str))
