"""B5 — Circuit Breaker: Open and Recovery.
Anthropic route, breaker_threshold toggle (hot-reloadable).

Proves: After repeated upstream 429s (concurrency type), breaker opens
and blocks further requests with gate 503.

Since Code Max has unlimited requests, we can't naturally trigger upstream 429s.
Instead, we point the proxy at a mock 429 server for the ON arm.
The mock returns HTTP 429 with Retry-After: 5 (classified as "concurrency" type).

Uses direct curl calls (not pi) to avoid retry logic interfering with breaker timing.
Server is managed via tmux sessions to keep processes alive.
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
    get_gate_stats,
    set_config,
    wait_for_queue_drain,
)
from metrics import count_status, count_gate_reason

N = 5  # Number of requests (must exceed breaker_threshold=3)
COOLDOWN_MS = 60000  # 60s cooldown so breaker stays open during measurement

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
MOCK_SERVER = "/tmp/mock429.py"


def _server_pid() -> int | None:
    result = subprocess.run(
        ["pgrep", "-f", "bun.*src/cli.ts"], capture_output=True, text=True
    )
    pids = [p for p in result.stdout.strip().split("\n") if p]
    return int(pids[0]) if pids else None


def _stop_server():
    """Stop the umans-gate server."""
    pid = _server_pid()
    if pid:
        os.kill(pid, 15)
        time.sleep(2)


def _update_config_file(patch: dict):
    """Write config patch to config.json before server start."""
    config_path = os.path.expanduser("~/.config/umans-gate/config.json")
    with open(config_path) as f:
        cfg = json.load(f)
    cfg.update(patch)
    with open(config_path, "w") as f:
        json.dump(cfg, f, indent=2)


def _start_server(target: str, breaker_threshold: int = 999, cooldown_ms: int = 5000):
    """Start umans-gate server with given TARGET and breaker config.

    Breaker config is written to config.json BEFORE server start because
    hot-reloading breaker_threshold via POST /dashboard/api/config does not
    properly reconfigure the CircuitBreaker instance (the reconfigure() call
    appears to be a no-op for the threshold field in practice).
    """
    _update_config_file({
        "breaker_threshold": breaker_threshold,
        "breaker_cooldown_ms": cooldown_ms,
        "breaker_window_ms": 300000,
    })
    result = subprocess.run(
        ["bash", "/tmp/start_gate_server.sh", target],
        capture_output=True, text=True, timeout=45,
    )
    if result.returncode != 0:
        raise RuntimeError(f"Server failed to start: {result.stderr}")
    for _ in range(5):
        try:
            cfg = get_config()
            if cfg:
                return
        except Exception:
            time.sleep(1)
    raise RuntimeError("Server failed health check")


def _ensure_mock_server():
    """Ensure mock 429 server is running in tmux session 'mock'."""
    # Check if mock session exists and server is alive
    result = subprocess.run(
        ["tmux", "has-session", "-t", "mock"], capture_output=True
    )
    if result.returncode == 0:
        # Check if port 9999 responds
        try:
            subprocess.run(
                ["curl", "-s", "-o", "/dev/null", "http://127.0.0.1:9999/v1/models"],
                timeout=3, capture_output=True,
            )
            return  # Mock already running
        except Exception:
            pass

    # Start mock server in tmux
    subprocess.run(["tmux", "kill-session", "-t", "mock"], capture_output=True)
    subprocess.run(
        ["tmux", "new-session", "-d", "-s", "mock", "-x", "200", "-y", "50"],
        capture_output=True,
    )
    subprocess.run(
        ["tmux", "send-keys", "-t", "mock",
         f"python3 {MOCK_SERVER}", "Enter"],
        capture_output=True,
    )
    time.sleep(1)


def _curl_post(body: dict) -> int:
    """Send a POST /v1/messages request via curl, return HTTP status code."""
    api_key = os.environ.get("UMANS_API_KEY", "")
    cmd = [
        "curl", "-s", "-o", "/dev/null", "-w", "%{http_code}",
        "-X", "POST", "http://localhost:1945/v1/messages",
        "-H", "Content-Type: application/json",
        "-H", f"x-api-key: {api_key}",
        "-H", "anthropic-version: 2023-06-01",
        "-d", json.dumps(body),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    try:
        return int(result.stdout.strip())
    except ValueError:
        return 0


def run(iterations: int = 2) -> dict:
    results = {"off": [], "on": []}
    request_body = {
        "model": "umans-glm-5.2",
        "max_tokens": 10,
        "messages": [{"role": "user", "content": "Say hi"}],
    }

    for i in range(iterations):
        print(f"  B5 iteration {i+1}/{iterations}", flush=True)

        # OFF: real upstream, breaker disabled (threshold=999)
        print("    OFF: starting server with real upstream...", flush=True)
        _start_server("https://api.code.umans.ai", breaker_threshold=999, cooldown_ms=5000)
        time.sleep(1)
        clear_captures()
        print(f"    OFF: sending {N} requests...", flush=True)
        for j in range(N):
            status = _curl_post(request_body)
            print(f"      req {j+1}: HTTP {status}", flush=True)
            time.sleep(0.3)
        wait_for_queue_drain()
        caps_off = get_captures()
        gate_off = get_gate_stats()
        results["off"].append({
            "captures": len(caps_off),
            "upstream_429": count_status(caps_off, 429, "upstream"),
            "gate_503": count_status(caps_off, 503),
            "gate_rejections": count_gate_reason(caps_off, "Circuit breaker open"),
            "breaker_state": gate_off.get("breaker"),
        })
        print(f"    OFF done: {results['off'][-1]}", flush=True)

        # ON: mock 429 upstream, breaker_threshold=3
        print("    ON: ensuring mock server...", flush=True)
        _ensure_mock_server()
        print("    ON: starting server with mock upstream...", flush=True)
        _start_server("http://127.0.0.1:9999", breaker_threshold=3, cooldown_ms=60000)
        time.sleep(1)
        clear_captures()
        print(f"    ON: sending {N} requests...", flush=True)
        for j in range(N):
            status = _curl_post(request_body)
            print(f"      req {j+1}: HTTP {status}", flush=True)
            time.sleep(0.3)
        wait_for_queue_drain()
        caps_on = get_captures()
        gate_on = get_gate_stats()
        results["on"].append({
            "captures": len(caps_on),
            "upstream_429": count_status(caps_on, 429, "upstream"),
            "gate_503": count_status(caps_on, 503),
            "gate_rejections": count_gate_reason(caps_on, "Circuit breaker open"),
            "breaker_state": gate_on.get("breaker"),
        })
        print(f"    ON done: {results['on'][-1]}", flush=True)

    # Restore real upstream
    print("    Restoring real upstream...", flush=True)
    _start_server("https://api.code.umans.ai", breaker_threshold=999, cooldown_ms=5000)

    off_503 = statistics.median([r["gate_503"] for r in results["off"]])
    on_503 = statistics.median([r["gate_503"] for r in results["on"]])
    on_rejections = statistics.median([r["gate_rejections"] for r in results["on"]])
    return {
        "benchmark": "B5 — Circuit Breaker",
        "iterations": iterations,
        "off": results["off"],
        "on": results["on"],
        "summary": {
            "gate_503_off_median": off_503,
            "gate_503_on_median": on_503,
            "circuit_open_rejections_on_median": on_rejections,
            "pass": on_503 > 0,
        },
    }


if __name__ == "__main__":
    result = run()
    results_dir = os.path.join(os.path.dirname(__file__), "..", "..", ".omo", "results")
    os.makedirs(results_dir, exist_ok=True)
    path = os.path.join(results_dir, "b5_result.json")
    with open(path, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"\nSaved to {path}")
    print(json.dumps(result, indent=2, default=str))
