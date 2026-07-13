"""B1 — TTL Stamping Impact.
Anthropic route, stamp_claude_code_enabled toggle.
Proves: Stamping ttl:"1h" onto cache_control blocks increases cache hit ratio.
"""

import statistics
from capture_reader import (
    clear_captures,
    get_captures,
    get_economics,
    set_config,
    wait_for_queue_drain,
)
from harness import pi_oneshot
from metrics import cache_hit_ratio, cache_creation_tokens, total_tokens

PROVIDER = "umans-proxy-anthropic"
MODEL = "umans-glm-5.2"
TURNS = 5
PROMPT_TEMPLATE = "Explain module {i} of the AGENTS.md file architecture in detail"
TIMEOUT = 300


def run(iterations: int = 3) -> dict:
    results = {"off": [], "on": []}
    for i in range(iterations):
        print(f"  B1 iteration {i+1}/{iterations}")
        # OFF
        set_config({"stamp_claude_code_enabled": False})
        clear_captures()
        for turn in range(1, TURNS + 1):
            pi_oneshot(
                PROMPT_TEMPLATE.format(i=turn),
                provider=PROVIDER,
                model=MODEL,
                session=f"bench-b1-off-{i}",
                continue_session=turn > 1,
                timeout=TIMEOUT,
            )
        wait_for_queue_drain()
        caps_off = get_captures()
        results["off"].append({
            "cache_hit_ratio": cache_hit_ratio(caps_off),
            "cache_creation": cache_creation_tokens(caps_off),
            "tokens": total_tokens(caps_off),
            "captures": len(caps_off),
        })
        # ON
        set_config({"stamp_claude_code_enabled": True})
        clear_captures()
        for turn in range(1, TURNS + 1):
            pi_oneshot(
                PROMPT_TEMPLATE.format(i=turn),
                provider=PROVIDER,
                model=MODEL,
                session=f"bench-b1-on-{i}",
                continue_session=turn > 1,
                timeout=TIMEOUT,
            )
        wait_for_queue_drain()
        caps_on = get_captures()
        results["on"].append({
            "cache_hit_ratio": cache_hit_ratio(caps_on),
            "cache_creation": cache_creation_tokens(caps_on),
            "tokens": total_tokens(caps_on),
            "captures": len(caps_on),
        })
    off_ratio = statistics.median([r["cache_hit_ratio"] for r in results["off"]])
    on_ratio = statistics.median([r["cache_hit_ratio"] for r in results["on"]])
    return {
        "benchmark": "B1 — TTL Stamping Impact",
        "iterations": iterations,
        "off": results["off"],
        "on": results["on"],
        "summary": {
            "cache_hit_ratio_off_median": off_ratio,
            "cache_hit_ratio_on_median": on_ratio,
            "delta": on_ratio - off_ratio,
            "pass": on_ratio > off_ratio,
        },
    }


if __name__ == "__main__":
    import json
    import os

    result = run(iterations=2)
    results_dir = os.path.join(os.path.dirname(__file__), "..", "..", ".omo", "results")
    os.makedirs(results_dir, exist_ok=True)
    path = os.path.join(results_dir, "b1_result.json")
    with open(path, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"\nSaved to {path}")
    print(json.dumps(result, indent=2, default=str))
