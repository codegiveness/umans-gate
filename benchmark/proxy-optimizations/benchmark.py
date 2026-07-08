#!/usr/bin/env python3
"""Proxy optimization benchmarks.

Tests transport-level optimizations against the real UMANS API:
  1. HTTP/1.1 vs HTTP/2 upstream protocol
  2. Keep-alive connection reuse (cold vs warm)
  3. accept-encoding: identity vs gzip on SSE streams
  4. Streaming vs non-streaming latency

Measures: TTFB, total latency, tokens/sec, connection reuse.

Usage:
  python benchmark.py --runs 5
  python benchmark.py --runs 3 --tests "h1,h2,gzip"
"""

from __future__ import annotations

import argparse
import functools
import json
import os
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import httpx

# ─── Config ────────────────────────────────────────────────────────────────

API_BASE = "https://api.code.umans.ai/v1"
API_KEY = os.environ.get("UMANS_API_KEY", "")
if not API_KEY:
    print("ERROR: UMANS_API_KEY env var not set", file=sys.stderr)
    sys.exit(1)

RESULTS_DIR = Path(__file__).resolve().parent / "results"
RESULTS_DIR.mkdir(parents=True, exist_ok=True)

# Force flush for live output
print = functools.partial(print, flush=True)  # type: ignore[assignment]

# Model choices — flash is fast, glm is the target model
MODEL_FAST = "umans-flash"
MODEL_GLM = "umans-glm-5.2"

# System prompt — small, stable prefix for cache warm-up
SYSTEM_PROMPT = (
    "You are a helpful assistant. Answer concisely. "
    "This is a benchmark test of proxy transport optimizations. "
    "Please respond with exactly one sentence."
)

# User prompt — small, consistent
USER_PROMPT = "What is 2+2? Answer in one word."

# ─── Helpers ──────────────────────────────────────────────────────────────


def make_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Build auth headers with optional overrides."""
    h = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        h.update(extra)
    return h


def make_openai_payload(
    model: str,
    stream: bool = False,
    max_tokens: int = 50,
) -> dict:
    """Build a minimal OpenAI chat completion payload."""
    return {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": USER_PROMPT},
        ],
        "max_tokens": max_tokens,
        "stream": stream,
        "top_k": -1,
    }


def make_anthropic_payload(
    model: str,
    stream: bool = False,
    max_tokens: int = 50,
) -> dict:
    """Build a minimal Anthropic messages payload."""
    return {
        "model": model,
        "system": SYSTEM_PROMPT,
        "messages": [{"role": "user", "content": USER_PROMPT}],
        "max_tokens": max_tokens,
        "stream": stream,
        "top_k": -1,
    }


def measure_request(
    client: httpx.Client,
    url: str,
    payload: dict,
    headers: dict[str, str],
    stream: bool = False,
    timeout: float = 120.0,
) -> dict:
    """Send a single request and measure TTFB, total latency, tokens.

    Returns dict with:
      - status: HTTP status code
      - ttfb_ms: time to first byte (ms)
      - total_ms: total request time (ms)
      - tokens: completion tokens (if available)
      - tokens_per_sec: tokens / (total_ms - ttfb_ms) * 1000
      - error: error message if failed
    """
    start = time.perf_counter()
    ttfb = None

    try:
        if stream:
            with client.stream(
                "POST", url, json=payload, headers=headers, timeout=timeout
            ) as resp:
                ttfb = time.perf_counter() - start
                body = b""
                for chunk in resp.iter_bytes():
                    body += chunk
                total = time.perf_counter() - start

                tokens = _extract_stream_tokens(body.decode("utf-8", errors="replace"))
                return {
                    "status": resp.status_code,
                    "ttfb_ms": round(ttfb * 1000, 1),
                    "total_ms": round(total * 1000, 1),
                    "tokens": tokens,
                    "tokens_per_sec": _tps(tokens, ttfb, total),
                    "error": None,
                }
        else:
            resp = client.post(url, json=payload, headers=headers, timeout=timeout)
            ttfb = time.perf_counter() - start
            total = time.perf_counter() - start
            data = resp.json()
            tokens = (
                data.get("usage", {}).get("completion_tokens")
                or data.get("usage", {}).get("output_tokens")
                or 0
            )
            return {
                "status": resp.status_code,
                "ttfb_ms": round(ttfb * 1000, 1),
                "total_ms": round(total * 1000, 1),
                "tokens": tokens,
                "tokens_per_sec": _tps(tokens, ttfb, total),
                "error": None,
            }
    except Exception as e:
        total = time.perf_counter() - start
        return {
            "status": 0,
            "ttfb_ms": round((ttfb or total) * 1000, 1) if ttfb else 0,
            "total_ms": round(total * 1000, 1),
            "tokens": 0,
            "tokens_per_sec": 0,
            "error": str(e),
        }


def _extract_stream_tokens(body: str) -> int:
    """Extract token count from SSE stream body."""
    tokens = 0
    for line in body.split("\n"):
        if not line.startswith("data: "):
            continue
        data = line[6:].strip()
        if data == "[DONE]" or not data:
            continue
        try:
            obj = json.loads(data)
            # OpenAI format
            if "usage" in obj:
                tokens = (
                    obj["usage"].get("completion_tokens")
                    or obj["usage"].get("output_tokens")
                    or tokens
                )
            # Anthropic format (message_delta event)
            if obj.get("type") == "message_delta":
                u = obj.get("usage", {})
                if "output_tokens" in u:
                    tokens = u["output_tokens"]
        except (json.JSONDecodeError, KeyError):
            continue
    return tokens


def _tps(tokens: int, ttfb: float, total: float) -> float:
    """Calculate tokens per second (generation phase only)."""
    gen_time = total - ttfb
    if gen_time <= 0 or tokens <= 0:
        return 0
    return round(tokens / gen_time, 1)


def stats(values: list[float]) -> dict:
    """Compute min, max, mean, median, stdev for a list of floats."""
    if not values:
        return {"min": 0, "max": 0, "mean": 0, "median": 0, "stdev": 0}
    return {
        "min": round(min(values), 1),
        "max": round(max(values), 1),
        "mean": round(statistics.mean(values), 1),
        "median": round(statistics.median(values), 1),
        "stdev": round(statistics.stdev(values), 1) if len(values) > 1 else 0,
    }


# ─── Test 1: HTTP/1.1 vs HTTP/2 ──────────────────────────────────────────


def test_http_protocol(runs: int) -> dict:
    """Compare HTTP/1.1 vs HTTP/2 upstream protocol.

    Note: httpx doesn't support forcing HTTP/2 vs HTTP/1.1 at the transport
    level the same way Bun's `protocol` option does. We use httpx's HTTP/2
    support (h2 package required) to test both protocols.

    For the proxy, Bun's `protocol: "http2"` vs `protocol: "http1.1"` is the
    real comparison. Here we test the upstream directly.
    """
    print("\n" + "=" * 70)
    print("TEST 1: HTTP/1.1 vs HTTP/2 upstream protocol")
    print("=" * 70)

    url = f"{API_BASE}/chat/completions"
    payload = make_openai_payload(MODEL_FAST, stream=False, max_tokens=30)
    headers = make_headers()

    results: dict[str, list[dict]] = {"http1.1": [], "http2": []}

    for proto_label, http2 in [("http1.1", False), ("http2", True)]:
        print(f"\n--- {proto_label} ---")
        # Use a fresh client per protocol to avoid pool contamination
        with httpx.Client(http2=http2, http1=not http2) as client:
            for i in range(runs):
                r = measure_request(client, url, payload, headers, stream=False)
                results[proto_label].append(r)
                status = r["status"]
                ttfb = r["ttfb_ms"]
                total = r["total_ms"]
                print(f"  run {i+1}/{runs}: status={status} ttfb={ttfb}ms total={total}ms")

    # Compute stats
    summary: dict[str, dict] = {}
    for proto, runs_list in results.items():
        ok_runs = [r for r in runs_list if r["error"] is None]
        summary[proto] = {
            "runs": len(ok_runs),
            "ttfb": stats([r["ttfb_ms"] for r in ok_runs]),
            "total": stats([r["total_ms"] for r in ok_runs]),
            "errors": len([r for r in runs_list if r["error"] is not None]),
        }

    # Compare
    if summary["http1.1"]["runs"] > 0 and summary["http2"]["runs"] > 0:
        h1_median = summary["http1.1"]["total"]["median"]
        h2_median = summary["http2"]["total"]["median"]
        diff = h2_median - h1_median
        pct = round((diff / h1_median) * 100, 1) if h1_median else 0
        print(f"\n📊 Comparison (median total latency):")
        print(f"   HTTP/1.1: {h1_median}ms")
        print(f"   HTTP/2:   {h2_median}ms")
        print(f"   Diff:     {diff:+.1f}ms ({pct:+.1f}%)")
        if h2_median < h1_median:
            print(f"   → HTTP/2 is faster by {abs(diff):.1f}ms")
        else:
            print(f"   → HTTP/1.1 is faster by {abs(diff):.1f}ms")

    return {"test": "http_protocol", "results": results, "summary": summary}


# ─── Test 2: Keep-alive connection reuse ──────────────────────────────────


def test_keepalive(runs: int) -> dict:
    """Test cold (new client) vs warm (reused client) connection.

    Bun's fetch maintains an internal connection pool. This test measures
    whether connection reuse provides measurable latency benefit.
    """
    print("\n" + "=" * 70)
    print("TEST 2: Keep-alive connection reuse (cold vs warm)")
    print("=" * 70)

    url = f"{API_BASE}/chat/completions"
    payload = make_openai_payload(MODEL_FAST, stream=False, max_tokens=30)
    headers = make_headers()

    results: dict[str, list[dict]] = {"cold": [], "warm": []}

    # Cold: new client per request (no connection reuse)
    print("\n--- cold (new client per request) ---")
    for i in range(runs):
        with httpx.Client() as client:
            r = measure_request(client, url, payload, headers)
            results["cold"].append(r)
            print(
                f"  run {i+1}/{runs}: status={r['status']} "
                f"ttfb={r['ttfb_ms']}ms total={r['total_ms']}ms"
            )

    # Warm: single client, sequential requests (connection reuse)
    print("\n--- warm (reused client, sequential) ---")
    with httpx.Client() as client:
        for i in range(runs):
            r = measure_request(client, url, payload, headers)
            results["warm"].append(r)
            print(
                f"  run {i+1}/{runs}: status={r['status']} "
                f"ttfb={r['ttfb_ms']}ms total={r['total_ms']}ms"
            )

    summary: dict[str, dict] = {}
    for label, runs_list in results.items():
        ok_runs = [r for r in runs_list if r["error"] is None]
        summary[label] = {
            "runs": len(ok_runs),
            "ttfb": stats([r["ttfb_ms"] for r in ok_runs]),
            "total": stats([r["total_ms"] for r in ok_runs]),
        }

    # Compare
    if summary["cold"]["runs"] > 0 and summary["warm"]["runs"] > 0:
        cold_median = summary["cold"]["total"]["median"]
        warm_median = summary["warm"]["total"]["median"]
        diff = cold_median - warm_median
        pct = round((diff / cold_median) * 100, 1) if cold_median else 0
        print(f"\n📊 Comparison (median total latency):")
        print(f"   Cold (new client): {cold_median}ms")
        print(f"   Warm (reused):    {warm_median}ms")
        print(f"   Diff:              {diff:+.1f}ms ({pct:+.1f}%)")
        if warm_median < cold_median:
            print(f"   → Keep-alive saves {abs(diff):.1f}ms")
        else:
            print(f"   → No benefit from keep-alive (cold is {abs(diff):.1f}ms faster)")

    return {"test": "keepalive", "results": results, "summary": summary}


# ─── Test 3: accept-encoding: identity vs gzip ────────────────────────────


def test_encoding(runs: int) -> dict:
    """Test identity vs gzip accept-encoding.

    The proxy forces `accept-encoding: identity` on all upstream requests.
    This test verifies whether gzip adds overhead on SSE streams.
    """
    print("\n" + "=" * 70)
    print("TEST 3: accept-encoding: identity vs gzip (SSE stream)")
    print("=" * 70)

    url = f"{API_BASE}/chat/completions"
    payload = make_openai_payload(MODEL_FAST, stream=True, max_tokens=50)

    results: dict[str, list[dict]] = {"identity": [], "gzip": []}

    for enc_label, enc_value in [("identity", "identity"), ("gzip", "gzip")]:
        print(f"\n--- {enc_label} ---")
        headers = make_headers({"Accept-Encoding": enc_value})
        with httpx.Client() as client:
            for i in range(runs):
                r = measure_request(client, url, payload, headers, stream=True)
                results[enc_label].append(r)
                print(
                    f"  run {i+1}/{runs}: status={r['status']} "
                    f"ttfb={r['ttfb_ms']}ms total={r['total_ms']}ms "
                    f"tokens={r['tokens']} tps={r['tokens_per_sec']}"
                )

    summary: dict[str, dict] = {}
    for enc, runs_list in results.items():
        ok_runs = [r for r in runs_list if r["error"] is None]
        summary[enc] = {
            "runs": len(ok_runs),
            "ttfb": stats([r["ttfb_ms"] for r in ok_runs]),
            "total": stats([r["total_ms"] for r in ok_runs]),
            "tps": stats([r["tokens_per_sec"] for r in ok_runs if r["tokens_per_sec"] > 0]),
        }

    if summary["identity"]["runs"] > 0 and summary["gzip"]["runs"] > 0:
        id_total = summary["identity"]["total"]["median"]
        gz_total = summary["gzip"]["total"]["median"]
        diff = gz_total - id_total
        pct = round((diff / id_total) * 100, 1) if id_total else 0
        print(f"\n📊 Comparison (median total latency, SSE stream):")
        print(f"   identity: {id_total}ms")
        print(f"   gzip:     {gz_total}ms")
        print(f"   Diff:     {diff:+.1f}ms ({pct:+.1f}%)")
        if id_total <= gz_total:
            print(f"   → identity is faster or equal (proxy default is correct)")
        else:
            print(f"   → gzip is faster by {abs(diff):.1f}ms (investigate)")

    return {"test": "encoding", "results": results, "summary": summary}


# ─── Test 4: OpenAI vs Anthropic path latency ─────────────────────────────


def test_api_path(runs: int) -> dict:
    """Compare /v1/chat/completions vs /v1/messages latency."""
    print("\n" + "=" * 70)
    print("TEST 4: OpenAI vs Anthropic API path latency")
    print("=" * 70)

    openai_url = f"{API_BASE}/chat/completions"
    anthropic_url = f"{API_BASE}/messages"
    openai_payload = make_openai_payload(MODEL_FAST, stream=False, max_tokens=30)
    anthropic_payload = make_anthropic_payload(MODEL_FAST, stream=False, max_tokens=30)
    headers = make_headers()

    results: dict[str, list[dict]] = {"openai": [], "anthropic": []}

    # Alternate to avoid cache ordering effects
    with httpx.Client() as client:
        for i in range(runs):
            # OpenAI
            r_oai = measure_request(client, openai_url, openai_payload, headers)
            results["openai"].append(r_oai)
            print(f"  openai   run {i+1}/{runs}: {r_oai['total_ms']}ms")

            # Anthropic
            r_ant = measure_request(client, anthropic_url, anthropic_payload, headers)
            results["anthropic"].append(r_ant)
            print(f"  anthropic run {i+1}/{runs}: {r_ant['total_ms']}ms")

    summary: dict[str, dict] = {}
    for path, runs_list in results.items():
        ok_runs = [r for r in runs_list if r["error"] is None]
        summary[path] = {
            "runs": len(ok_runs),
            "ttfb": stats([r["ttfb_ms"] for r in ok_runs]),
            "total": stats([r["total_ms"] for r in ok_runs]),
        }

    if summary["openai"]["runs"] > 0 and summary["anthropic"]["runs"] > 0:
        oai = summary["openai"]["total"]["median"]
        ant = summary["anthropic"]["total"]["median"]
        diff = ant - oai
        print(f"\n📊 Comparison (median total latency):")
        print(f"   OpenAI:    {oai}ms")
        print(f"   Anthropic: {ant}ms")
        print(f"   Diff:      {diff:+.1f}ms")

    return {"test": "api_path", "results": results, "summary": summary}


# ─── Test 5: Streaming vs non-streaming ──────────────────────────────────


def test_streaming(runs: int) -> dict:
    """Compare streaming vs non-streaming TTFB and total latency."""
    print("\n" + "=" * 70)
    print("TEST 5: Streaming vs non-streaming latency")
    print("=" * 70)

    url = f"{API_BASE}/chat/completions"
    payload_ns = make_openai_payload(MODEL_FAST, stream=False, max_tokens=50)
    payload_s = make_openai_payload(MODEL_FAST, stream=True, max_tokens=50)
    headers = make_headers()

    results: dict[str, list[dict]] = {"non_stream": [], "stream": []}

    with httpx.Client() as client:
        # Non-stream first
        print("\n--- non-stream ---")
        for i in range(runs):
            r = measure_request(client, url, payload_ns, headers, stream=False)
            results["non_stream"].append(r)
            print(f"  run {i+1}/{runs}: ttfb={r['ttfb_ms']}ms total={r['total_ms']}ms")

        # Stream
        print("\n--- stream ---")
        for i in range(runs):
            r = measure_request(client, url, payload_s, headers, stream=True)
            results["stream"].append(r)
            print(
                f"  run {i+1}/{runs}: ttfb={r['ttfb_ms']}ms "
                f"total={r['total_ms']}ms tps={r['tokens_per_sec']}"
            )

    summary: dict[str, dict] = {}
    for label, runs_list in results.items():
        ok_runs = [r for r in runs_list if r["error"] is None]
        summary[label] = {
            "runs": len(ok_runs),
            "ttfb": stats([r["ttfb_ms"] for r in ok_runs]),
            "total": stats([r["total_ms"] for r in ok_runs]),
            "tps": stats([r["tokens_per_sec"] for r in ok_runs if r["tokens_per_sec"] > 0]),
        }

    if summary["non_stream"]["runs"] > 0 and summary["stream"]["runs"] > 0:
        ns_ttfb = summary["non_stream"]["ttfb"]["median"]
        s_ttfb = summary["stream"]["ttfb"]["median"]
        print(f"\n📊 TTFB comparison (median):")
        print(f"   Non-stream: {ns_ttfb}ms")
        print(f"   Stream:    {s_ttfb}ms")
        print(f"   Diff:      {s_ttfb - ns_ttfb:+.1f}ms")

    return {"test": "streaming", "results": results, "summary": summary}


# ─── Report generation ────────────────────────────────────────────────────


def generate_report(all_results: list[dict], run_id: str) -> None:
    """Generate markdown report and save to results dir."""
    first_test = all_results[0] if all_results else None
    runs_per_test = 0
    if first_test and first_test["summary"]:
        first_variant = next(iter(first_test["summary"].values()))
        runs_per_test = first_variant.get("runs", 0)
    lines = [
        "# Proxy Optimization Benchmark Report",
        "",
        f"**Date:** {datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}",
        f"**API:** `{API_BASE}`",
        f"**API Key:** `{API_KEY[:8]}...{API_KEY[-4:]}`",
        f"**Runs per test:** {runs_per_test}",
        "",
        "## Methodology",
        "",
        "- Direct upstream API calls (no proxy in path).",
        "- Each test runs N sequential requests, alternating where noted.",
        "- Measures TTFB, total latency, tokens/sec.",
        "- Uses `httpx` with HTTP/2 support for protocol comparison.",
        "",
    ]

    # Summary table
    lines.append("## Summary Results")
    lines.append("")
    lines.append("| Test | Comparison | Metric | Value A | Value B | Diff | Winner |")
    lines.append("|------|------------|--------|---------|---------|------|--------|")

    for result in all_results:
        test_name = result["test"]
        summary = result["summary"]

        if test_name == "http_protocol":
            h1 = summary["http1.1"]["total"]["median"]
            h2 = summary["http2"]["total"]["median"]
            diff = h2 - h1
            winner = "HTTP/1.1" if h1 <= h2 else "HTTP/2"
            lines.append(
                f"| {test_name} | HTTP/1.1 vs HTTP/2 | median total (ms) | "
                f"{h1} | {h2} | {diff:+.1f} | {winner} |"
            )
        elif test_name == "keepalive":
            cold = summary["cold"]["total"]["median"]
            warm = summary["warm"]["total"]["median"]
            diff = cold - warm
            winner = "warm (keep-alive)" if warm <= cold else "cold"
            lines.append(
                f"| {test_name} | cold vs warm | median total (ms) | "
                f"{cold} | {warm} | {diff:+.1f} | {winner} |"
            )
        elif test_name == "encoding":
            identity = summary["identity"]["total"]["median"]
            gzip = summary["gzip"]["total"]["median"]
            diff = gzip - identity
            winner = "identity" if identity <= gzip else "gzip"
            lines.append(
                f"| {test_name} | identity vs gzip (SSE) | median total (ms) | "
                f"{identity} | {gzip} | {diff:+.1f} | {winner} |"
            )
        elif test_name == "api_path":
            oai = summary["openai"]["total"]["median"]
            ant = summary["anthropic"]["total"]["median"]
            diff = ant - oai
            winner = "OpenAI" if oai <= ant else "Anthropic"
            lines.append(
                f"| {test_name} | OpenAI vs Anthropic | median total (ms) | "
                f"{oai} | {ant} | {diff:+.1f} | {winner} |"
            )
        elif test_name == "streaming":
            ns_ttfb = summary["non_stream"]["ttfb"]["median"]
            s_ttfb = summary["stream"]["ttfb"]["median"]
            diff = s_ttfb - ns_ttfb
            winner = "stream" if s_ttfb <= ns_ttfb else "non-stream"
            lines.append(
                f"| {test_name} | stream vs non-stream | median TTFB (ms) | "
                f"{ns_ttfb} | {s_ttfb} | {diff:+.1f} | {winner} |"
            )

    lines.append("")

    # Detailed results per test
    lines.append("## Detailed Results")
    lines.append("")

    for result in all_results:
        test_name = result["test"]
        summary = result["summary"]
        lines.append(f"### {test_name}")
        lines.append("")

        for variant, s in summary.items():
            lines.append(f"**{variant}**:")
            lines.append(f"- TTFB: min={s['ttfb']['min']}ms, median={s['ttfb']['median']}ms, max={s['ttfb']['max']}ms, mean={s['ttfb']['mean']}ms (±{s['ttfb']['stdev']})")
            lines.append(f"- Total: min={s['total']['min']}ms, median={s['total']['median']}ms, max={s['total']['max']}ms, mean={s['total']['mean']}ms (±{s['total']['stdev']})")
            if "tps" in s and s["tps"]["median"] > 0:
                lines.append(f"- Tokens/sec: median={s['tps']['median']}, mean={s['tps']['mean']}")
            if s.get("errors", 0) > 0:
                lines.append(f"- Errors: {s['errors']}")
            lines.append("")

    # Decisions
    lines.append("## Optimization Decisions")
    lines.append("")
    lines.append("| Optimization | Decision | Rationale |")
    lines.append("|---|---|---|")

    for result in all_results:
        test_name = result["test"]
        summary = result["summary"]

        if test_name == "http_protocol":
            h1 = summary["http1.1"]["total"]["median"]
            h2 = summary["http2"]["total"]["median"]
            if h1 <= h2:
                lines.append(f"| HTTP/1.1 default | ✅ Keep default | HTTP/1.1 is {h2-h1:.1f}ms faster than HTTP/2 |")
            else:
                lines.append(f"| HTTP/2 upstream | 🔬 Consider switching | HTTP/2 is {h1-h2:.1f}ms faster |")
        elif test_name == "keepalive":
            cold = summary["cold"]["total"]["median"]
            warm = summary["warm"]["total"]["median"]
            if warm < cold:
                lines.append(f"| Keep-alive (Bun internal pool) | ✅ Already works | warm is {cold-warm:.1f}ms faster than cold |")
            else:
                lines.append(f"| Keep-alive pool | ❌ No benefit | cold is {warm-cold:.1f}ms faster (no reuse benefit) |")
        elif test_name == "encoding":
            identity = summary["identity"]["total"]["median"]
            gzip = summary["gzip"]["total"]["median"]
            if identity <= gzip:
                lines.append(f"| accept-encoding: identity | ✅ Keep (correct default) | identity is {gzip-identity:.1f}ms faster/equal on SSE |")
            else:
                lines.append(f"| gzip on SSE | 🔬 Investigate | gzip is {identity-gzip:.1f}ms faster — may benefit non-SSE |")

    lines.append("")

    report = "\n".join(lines)

    # Save
    report_path = RESULTS_DIR / f"proxy_optimizations_{run_id}.md"
    report_path.write_text(report, encoding="utf-8")
    latest_path = RESULTS_DIR / "proxy_optimizations_latest.md"
    latest_path.write_text(report, encoding="utf-8")
    print(f"\n📄 Report saved: {report_path}")
    print(f"📄 Report saved: {latest_path}")


def save_results(all_results: list[dict], run_id: str) -> None:
    """Save raw JSON results."""
    data = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "api_base": API_BASE,
        "run_id": run_id,
        "tests": all_results,
    }
    json_path = RESULTS_DIR / f"proxy_optimizations_{run_id}.json"
    json_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    latest_json = RESULTS_DIR / "proxy_optimizations_latest.json"
    latest_json.write_text(json.dumps(data, indent=2), encoding="utf-8")
    print(f"📊 JSON saved: {json_path}")
    print(f"📊 JSON saved: {latest_json}")


# ─── Main ─────────────────────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(description="Proxy optimization benchmarks")
    parser.add_argument(
        "--runs", type=int, default=5, help="Number of runs per test (default: 5)"
    )
    parser.add_argument(
        "--tests",
        type=str,
        default="all",
        help="Comma-separated test names: h1,h2,keepalive,gzip,api_path,streaming (default: all)",
    )
    args = parser.parse_args()

    run_id = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    print(f"🚀 Proxy Optimization Benchmark — {run_id}")
    print(f"   API: {API_BASE}")
    print(f"   Runs per test: {args.runs}")

    all_tests = {
        "h1": lambda: test_http_protocol(args.runs),
        "h2": lambda: test_http_protocol(args.runs),  # same test, runs both
        "keepalive": lambda: test_keepalive(args.runs),
        "gzip": lambda: test_encoding(args.runs),
        "api_path": lambda: test_api_path(args.runs),
        "streaming": lambda: test_streaming(args.runs),
    }

    if args.tests == "all":
        tests_to_run = ["h1", "keepalive", "gzip", "api_path", "streaming"]
    else:
        tests_to_run = [t.strip() for t in args.tests.split(",")]

    all_results: list[dict] = []
    for test_name in tests_to_run:
        if test_name in all_tests:
            result = all_tests[test_name]()
            all_results.append(result)
        else:
            print(f"⚠️  Unknown test: {test_name}, skipping")

    if not all_results:
        print("No tests ran!")
        return

    # Generate report
    generate_report(all_results, run_id)
    save_results(all_results, run_id)

    print(f"\n✅ Done — {len(all_results)} tests completed")


if __name__ == "__main__":
    main()
