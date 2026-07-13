"""Read captures and aggregates from dashboard API (read-only)."""

import json
import time
import urllib.request
from config import PROXY_URL


def _get(path: str, base: str = PROXY_URL):
    r = urllib.request.urlopen(f"{base}{path}")
    return json.loads(r.read())


def _post(path: str, data: dict | None = None, base: str = PROXY_URL):
    if data is not None:
        req = urllib.request.Request(
            f"{base}{path}",
            data=json.dumps(data).encode(),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
    else:
        req = urllib.request.Request(f"{base}{path}", method="POST")
    return urllib.request.urlopen(req).read()


def get_captures(base: str = PROXY_URL) -> list[dict]:
    return _get("/dashboard/api/captures", base)


def get_capture(capture_id: int, base: str = PROXY_URL) -> dict:
    return _get(f"/dashboard/api/captures/{capture_id}", base)


def get_gate_stats(base: str = PROXY_URL) -> dict:
    return _get("/dashboard/api/gate", base)


def get_performance(base: str = PROXY_URL) -> dict:
    return _get("/dashboard/api/performance", base)


def get_economics(base: str = PROXY_URL) -> dict:
    return _get("/dashboard/api/economics/summary", base)


def get_vision_calls(base: str = PROXY_URL) -> list[dict]:
    return _get("/dashboard/api/vision-calls", base)


def get_vision_cache_stats(base: str = PROXY_URL) -> dict:
    return _get("/dashboard/api/vision-cache-stats", base)


def get_config(base: str = PROXY_URL) -> dict:
    return _get("/dashboard/api/config", base)


def set_config(patch: dict, base: str = PROXY_URL):
    """POST a config patch and trigger hot-reload."""
    _post("/dashboard/api/config", patch, base)
    _post("/dashboard/api/config/reload", None, base)


def clear_captures(base: str = PROXY_URL):
    _post("/dashboard/api/clear", None, base)


def wait_for_queue_drain(base: str = PROXY_URL, timeout: float = 60.0):
    """Poll performance endpoint until queue depth = 0.

    Note: 'active' may show 0.5 due to a lingering reservation slot
    (not an actual in-flight request). Accept active <= 0.5 as drained.
    """
    deadline = time.time() + timeout
    while time.time() < deadline:
        stats = get_gate_stats(base)
        if stats.get("active", 0) <= 0.5 and stats.get("queued", 0) == 0:
            return True
        time.sleep(0.5)
    return False
