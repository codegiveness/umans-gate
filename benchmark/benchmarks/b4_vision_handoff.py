"""B4 — Vision Handoff: Image-to-Text Replacement.
Anthropic route, vision_strategy toggle (requires server restart).
Proves: Vision handoff replaces images with text, keeping conversations alive past 10-image limit.
"""

import json
import os
import statistics
import subprocess
import time
from capture_reader import (
    clear_captures,
    get_capture,
    get_captures,
    get_config,
    get_vision_calls,
    get_vision_cache_stats,
    set_config,
    wait_for_queue_drain,
)
from config import PI_PATH
from harness import _find_session_path
from metrics import count_status

PROVIDER = "umans-proxy-anthropic"
MODEL = "umans-glm-5.2"
TURNS = 8
# vision_max_images default is 5. Set high to ensure ALL images are replaced.
VISION_MAX_IMAGES_OVERRIDE = 50
IMAGES_DIR = os.path.join(os.path.dirname(__file__), "..", "..", "images-test")

IMAGES = [
    "compressed_akira-Ais5yzfb6SE-unsplash.jpg",
    "compressed_cara-willenbrock-qCk3mvhO3Po-unsplash.jpg",
    "compressed_christina-terzidou-eaBqnIKUiFc-unsplash.jpg",
    "compressed_darwin-vegher-IKLUTpz4cgA-unsplash.jpg",
    "compressed_jan-folwarczny-GypQ8LlnfvI-unsplash.jpg",
    "compressed_jezael-melgoza-TBw2nJIL6DM-unsplash.jpg",
    "compressed_long-chung-rT04rwoOi4M-unsplash.jpg",
    "compressed_max-bohme-cBiQfqb1BQU-unsplash.jpg",
    "compressed_microsoft-copilot-qUJ8fgoaLTg-unsplash.jpg",
    "compressed_mirjam-schuinder-vecqdAtg--4-unsplash.jpg",
    "compressed_rafael-peier-i_PCKiQD0r0-unsplash.jpg",
    "compressed_sandisk-gRBlPVBz5Zg-unsplash.jpg",
    "compressed_tobias-reich-4Doeilc8k0Y-unsplash.jpg",
    "compressed_tolga-ahmetler-kecdD42Ew_s-unsplash.jpg",
    "compressed_tolga-ahmetler-spvib-ow5Cg-unsplash.jpg",
    "compressed_zetong-li-4iNQdT4mDLc-unsplash.jpg",
]

PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))


def _server_pid() -> int | None:
    result = subprocess.run(
        ["pgrep", "-f", "bun.*src/cli.ts"], capture_output=True, text=True
    )
    pids = [p for p in result.stdout.strip().split("\n") if p]
    return int(pids[0]) if pids else None


def _restart_server(config_patch: dict):
    pid = _server_pid()
    if pid:
        os.kill(pid, 15)
        time.sleep(2)
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
    log_fd = open("/tmp/umans-gate-bench.log", "w")
    subprocess.Popen(
        ["bun", "run", "dev"],
        stdout=log_fd,
        stderr=subprocess.STDOUT,
        cwd=PROJECT_ROOT,
        start_new_session=True,
    )
    for _ in range(30):
        try:
            cfg = get_config()
            if cfg.get("vision_strategy") == config_patch.get("vision_strategy", cfg.get("vision_strategy")):
                return
            time.sleep(1)
        except Exception:
            time.sleep(1)


def _pi_with_image(
    image_path: str,
    prompt: str,
    provider: str = PROVIDER,
    model: str = MODEL,
    session_id: str | None = None,
    continue_session: bool = False,
    timeout: int = 180,
) -> int:
    """Run pi with an image attachment. Returns exit code (124 = timeout).

    pi CLI syntax: pi [options] @file -p "prompt"
    The @file argument must be a separate CLI arg, not embedded in the prompt.
    """
    cmd = [PI_PATH, "--print", "--provider", provider, "--model", model, "--tools", "read"]
    if session_id:
        if continue_session:
            path = _find_session_path(session_id)
            if path:
                cmd += ["--session", path, "--continue"]
            else:
                cmd += ["--session-id", session_id]
        else:
            cmd += ["--session-id", session_id]
    else:
        cmd += ["--no-session"]
    cmd += [f"@{image_path}", "-p", prompt]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
        return result.returncode
    except subprocess.TimeoutExpired:
        print(f"    [timeout] pi exceeded {timeout}s, skipping")
        return 124


def _run_workload(session_id: str) -> list[dict]:
    """Run 16-turn image session, return captures."""
    img_path = os.path.join(IMAGES_DIR, IMAGES[0])
    _pi_with_image(
        img_path,
        "Describe what you see in this image briefly.",
        session_id=session_id,
        timeout=180,
    )
    for i in range(1, TURNS):
        img_path = os.path.join(IMAGES_DIR, IMAGES[i])
        _pi_with_image(
            img_path,
            "Now look at this next image. Describe it briefly.",
            session_id=session_id,
            continue_session=True,
            timeout=180,
        )
    wait_for_queue_drain(timeout=120)
    return get_captures()


def _count_image_blocks(captures: list[dict]) -> int:
    """Count user-request captures (path=/v1/messages) whose body has an image block.

    Vision handoff internally calls /v1/chat/completions — those are NOT user requests
    and are excluded. Only Anthropic-route user requests are checked.
    """
    count = 0
    for c in captures:
        if c.get("path") != "/v1/messages":
            continue
        cap_id = c.get("id")
        if not cap_id:
            continue
        try:
            full = get_capture(cap_id)
            rb = full.get("request_body", "")
            if '"type":"image"' in rb or '"type": "image"' in rb:
                count += 1
        except Exception:
            pass
    return count


def _user_requests(captures: list[dict]) -> list[dict]:
    """Filter to only Anthropic-route user requests (exclude internal vision calls)."""
    return [c for c in captures if c.get("path") == "/v1/messages"]


def run(iterations: int = 1) -> dict:
    results = {"off": [], "on": []}
    for i in range(iterations):
        print(f"  B4 iteration {i+1}/{iterations}")
        # OFF: vision_strategy="never" — images pass through unchanged
        _restart_server({
            "vision_strategy": "never",
            "warmer_enabled": True,
            "vision_max_images": VISION_MAX_IMAGES_OVERRIDE,
        })
        clear_captures()
        caps_off = _run_workload(f"bench-b4-off-{i}")
        user_off = _user_requests(caps_off)
        image_blocks_off = _count_image_blocks(caps_off)
        results["off"].append({
            "captures": len(caps_off),
            "user_requests": len(user_off),
            "http_400": count_status(user_off, 400),
            "success_200": count_status(user_off, 200),
            "image_blocks_sent": image_blocks_off,
        })
        # ON: vision_strategy="always" — images replaced with text descriptions
        _restart_server({
            "vision_strategy": "always",
            "vision_model": "umans-flash",
            "vision_persistent_cache": True,
            "warmer_enabled": True,
            "vision_max_images": VISION_MAX_IMAGES_OVERRIDE,
        })
        clear_captures()
        caps_on = _run_workload(f"bench-b4-on-{i}")
        user_on = _user_requests(caps_on)
        image_blocks_on = _count_image_blocks(caps_on)
        vision_calls = get_vision_calls()
        vision_cache = get_vision_cache_stats()
        results["on"].append({
            "captures": len(caps_on),
            "user_requests": len(user_on),
            "http_400": count_status(user_on, 400),
            "success_200": count_status(user_on, 200),
            "image_blocks_sent": image_blocks_on,
            "vision_calls": len(vision_calls) if isinstance(vision_calls, list) else 0,
            "vision_cache_stats": vision_cache,
        })
    off_400 = statistics.median([r["http_400"] for r in results["off"]])
    on_400 = statistics.median([r["http_400"] for r in results["on"]])
    on_success = statistics.median([r["success_200"] for r in results["on"]])
    on_images = statistics.median([r["image_blocks_sent"] for r in results["on"]])
    return {
        "benchmark": "B4 — Vision Handoff",
        "iterations": iterations,
        "off": results["off"],
        "on": results["on"],
        "summary": {
            "http_400_off_median": off_400,
            "http_400_on_median": on_400,
            "success_200_on_median": on_success,
            "image_blocks_on_median": on_images,
            "pass": off_400 > 0 and on_400 == 0 and on_success > 0,
        },
    }


if __name__ == "__main__":
    import json
    import os

    result = run()
    results_dir = os.path.join(os.path.dirname(__file__), "..", "..", ".omo", "results")
    os.makedirs(results_dir, exist_ok=True)
    path = os.path.join(results_dir, "b4_result.json")
    with open(path, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"\nSaved to {path}")
    print(json.dumps(result, indent=2, default=str))
