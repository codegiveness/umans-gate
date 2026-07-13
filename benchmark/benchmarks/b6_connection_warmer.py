"""B6 — Connection Warmer: Cold-Start Penalty.
OpenAI route, warmer_enabled toggle (requires server restart).
Proves: Keeping connections warm reduces TTFT after idle.
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
from harness import pi_oneshot
from metrics import ttft_stats

PROVIDER = "umans-proxy"
MODEL = "umans-flash"
WARMER_PING_DELAY = 5  # seconds to wait for warmer's initial ping to complete


def _server_pids() -> list[int]:
    result = subprocess.run(
        ["pgrep", "-f", "bun (run dev|src/cli.ts)"], capture_output=True, text=True
    )
    pids = result.stdout.strip().split("\n")
    return [int(p) for p in pids if p.strip()]


def _restart_server(config_patch: dict):
    for pid in _server_pids():
        os.kill(pid, 15)
    time.sleep(3)
    config_path = os.path.expanduser(
        os.environ.get(
            "XDG_CONFIG_HOME", os.path.join(os.path.expanduser("~"), ".config")
        )
        + "/umans-gate/config.json"
    )
    with open(config_path) as f:
        cfg = json.load(f)
    cfg.update(config_patch)
    with open(config_path, "w") as f:
        json.dump(cfg, f, indent=2)
    subprocess.Popen(
        ["bun", "src/cli.ts"],
        stdout=open("/tmp/umans-gate-bench.log", "w"),
        stderr=subprocess.STDOUT,
        cwd=os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
        start_new_session=True,
    )
    time.sleep(3)
    for _ in range(20):
        try:
            get_config()
            return
        except Exception:
            time.sleep(1)


def run(iterations: int = 2) -> dict:
    results = {"off": [], "on": []}
    for i in range(iterations):
        print(f"  B6 iteration {i+1}/{iterations}", flush=True)
        # OFF: warmer_enabled=false
        print("    OFF: restarting server with warmer_enabled=false", flush=True)
        _restart_server({"warmer_enabled": False})
        print(f"    OFF: waiting {WARMER_PING_DELAY}s for warmer startup", flush=True)
        time.sleep(WARMER_PING_DELAY)
        clear_captures()
        print("    OFF: sending request", flush=True)
        pi_oneshot("Say hello", provider=PROVIDER, model=MODEL, timeout=60)
        time.sleep(2)
        wait_for_queue_drain()
        caps_off = get_captures()
        print(f"    OFF: {len(caps_off)} captures, ttft={ttft_stats(caps_off)}", flush=True)
        results["off"].append({"ttft": ttft_stats(caps_off)})
        # ON: warmer_enabled=true
        print("    ON: restarting server with warmer_enabled=true", flush=True)
        _restart_server({"warmer_enabled": True})
        print(f"    ON: waiting {WARMER_PING_DELAY}s for warmer startup", flush=True)
        time.sleep(WARMER_PING_DELAY)
        clear_captures()
        print("    ON: sending request", flush=True)
        pi_oneshot("Say hello", provider=PROVIDER, model=MODEL, timeout=60)
        time.sleep(2)
        wait_for_queue_drain()
        caps_on = get_captures()
        print(f"    ON: {len(caps_on)} captures, ttft={ttft_stats(caps_on)}", flush=True)
        results["on"].append({"ttft": ttft_stats(caps_on)})
    off_ttft = statistics.median([r["ttft"]["p50"] for r in results["off"]])
    on_ttft = statistics.median([r["ttft"]["p50"] for r in results["on"]])
    return {
        "benchmark": "B6 — Connection Warmer",
        "iterations": iterations,
        "off": results["off"],
        "on": results["on"],
        "summary": {
            "ttft_off_median_ms": off_ttft,
            "ttft_on_median_ms": on_ttft,
            "delta_ms": off_ttft - on_ttft,
            "pass": on_ttft < off_ttft,
        },
    }


if __name__ == "__main__":
    import json
    import os

    result = run()
    results_dir = os.path.join(os.path.dirname(__file__), "..", "..", ".omo", "results")
    os.makedirs(results_dir, exist_ok=True)
    path = os.path.join(results_dir, "b6_result.json")
    with open(path, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"\nSaved to {path}")
    print(json.dumps(result, indent=2, default=str))
