"""B2 — Concurrency Gate: Throughput & 429 Prevention.
OpenAI route, concurrency_hard_cap toggle.
Proves: Gate prevents upstream 429s by queuing at the hard cap.
"""

import statistics
import time
from capture_reader import (
    clear_captures,
    get_captures,
    get_gate_stats,
    set_config,
    wait_for_queue_drain,
)
from harness import pi_parallel
from metrics import count_status

PROVIDER = "umans-proxy"
MODEL = "umans-flash"
N = 4


def run(iterations: int = 3) -> dict:
    results = {"off": [], "on": []}
    for i in range(iterations):
        print(f"  B2 iteration {i+1}/{iterations}")
        # OFF: hard_cap=999 (no clamp, effective=soft_limit=8)
        set_config({"concurrency_hard_cap": 999})
        clear_captures()
        t0 = time.time()
        pi_parallel(
            N,
            lambda j: f"Explain what a binary search tree is in 3 sentences. Variant {j}",
            provider=PROVIDER,
            model=MODEL,
        )
        wall_off = time.time() - t0
        wait_for_queue_drain()
        caps_off = get_captures()
        gate_off = get_gate_stats()
        results["off"].append({
            "wall_seconds": wall_off,
            "captures": len(caps_off),
            "upstream_429": count_status(caps_off, 429, "upstream"),
            "gate_429": count_status(caps_off, 429, "gate"),
            "gate_503": count_status(caps_off, 503),
            "breaker": gate_off.get("breaker"),
        })
        # ON: hard_cap=4 (clamps to 4)
        set_config({"concurrency_hard_cap": 4})
        clear_captures()
        t0 = time.time()
        pi_parallel(
            N,
            lambda j: f"Explain what a binary search tree is in 3 sentences. Variant {j}",
            provider=PROVIDER,
            model=MODEL,
        )
        wall_on = time.time() - t0
        wait_for_queue_drain()
        caps_on = get_captures()
        gate_on = get_gate_stats()
        results["on"].append({
            "wall_seconds": wall_on,
            "captures": len(caps_on),
            "upstream_429": count_status(caps_on, 429, "upstream"),
            "gate_429": count_status(caps_on, 429, "gate"),
            "gate_503": count_status(caps_on, 503),
            "breaker": gate_on.get("breaker"),
        })
    off_429 = statistics.median([r["upstream_429"] for r in results["off"]])
    on_429 = statistics.median([r["upstream_429"] for r in results["on"]])
    return {
        "benchmark": "B2 — Concurrency Gate",
        "iterations": iterations,
        "off": results["off"],
        "on": results["on"],
        "summary": {
            "upstream_429_off_median": off_429,
            "upstream_429_on_median": on_429,
            "pass": on_429 == 0,
        },
    }
