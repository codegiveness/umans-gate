"""B3 — Rate Limiter: Request Window Enforcement.
OpenAI route, rate_limit_requests toggle.
Proves: Gate throttles requests before upstream window exhaustion.

Note: Code Max has unlimited requests (hard_cap=null). Setting
rate_limit_requests=0 auto-derives from /v1/usage, which returns null
on unlimited plans → no limiter is created. So the ON arm uses a small
positive integer (10) to force the sliding-window limiter active.
The window is 18000s (5hr) by default, so 30 burst requests against
a limit of 10 will trigger ~20 gate-level 429s.
"""

import statistics
import time
from capture_reader import (
    clear_captures,
    get_captures,
    set_config,
    wait_for_queue_drain,
)
from harness import pi_parallel
from metrics import count_status, count_gate_reason

PROVIDER = "umans-proxy"
MODEL = "umans-flash"
BURST = 30
# ON arm: small positive limit to force the sliding-window limiter active.
# Code Max is unlimited, so rate_limit_requests=0 returns null limiter.
RATE_LIMIT_ON = 10


def run(iterations: int = 3) -> dict:
    results = {"off": [], "on": []}
    for i in range(iterations):
        print(f"  B3 iteration {i+1}/{iterations}")
        # OFF: rate_limit_requests=-1 (disabled, no limiter)
        set_config({"rate_limit_requests": -1})
        clear_captures()
        t0 = time.time()
        pi_parallel(
            BURST,
            lambda j: f"What is {j} times {j}?",
            provider=PROVIDER,
            model=MODEL,
            timeout=180,
        )
        wall_off = time.time() - t0
        wait_for_queue_drain()
        caps_off = get_captures()
        results["off"].append({
            "wall_seconds": wall_off,
            "captures": len(caps_off),
            "upstream_429": count_status(caps_off, 429, "upstream"),
            "gate_throttle": count_gate_reason(caps_off, "Rate limit"),
            "success_200": count_status(caps_off, 200),
        })
        # ON: rate_limit_requests=10 (small positive → limiter active)
        # 30 burst requests against limit=10 → ~20 gate-level 429s
        set_config({"rate_limit_requests": RATE_LIMIT_ON})
        clear_captures()
        t0 = time.time()
        pi_parallel(
            BURST,
            lambda j: f"What is {j} times {j}?",
            provider=PROVIDER,
            model=MODEL,
            timeout=180,
        )
        wall_on = time.time() - t0
        wait_for_queue_drain()
        caps_on = get_captures()
        results["on"].append({
            "wall_seconds": wall_on,
            "captures": len(caps_on),
            "upstream_429": count_status(caps_on, 429, "upstream"),
            "gate_throttle": count_gate_reason(caps_on, "Rate limit"),
            "success_200": count_status(caps_on, 200),
        })
        # Reset rate limiter between iterations to avoid window carryover
        set_config({"rate_limit_requests": -1})
    off_throttle = statistics.median([r["gate_throttle"] for r in results["off"]])
    on_throttle = statistics.median([r["gate_throttle"] for r in results["on"]])
    on_up429 = statistics.median([r["upstream_429"] for r in results["on"]])
    on_success = statistics.median([r["success_200"] for r in results["on"]])
    return {
        "benchmark": "B3 — Rate Limiter",
        "iterations": iterations,
        "off": results["off"],
        "on": results["on"],
        "summary": {
            "gate_throttle_off_median": off_throttle,
            "gate_throttle_on_median": on_throttle,
            "upstream_429_on_median": on_up429,
            "success_200_on_median": on_success,
            "pass": on_throttle > 0 and on_up429 == 0,
        },
    }
