"""Compute metrics from captures."""

from statistics import median


def cache_hit_ratio(captures: list[dict]) -> float:
    """Cache read tokens / total input tokens."""
    total_in = sum(c.get("total_input_tokens", 0) or 0 for c in captures)
    cached = sum(c.get("cache_read_tokens", 0) or 0 for c in captures)
    return cached / total_in if total_in > 0 else 0.0


def cache_creation_tokens(captures: list[dict]) -> int:
    return sum(c.get("cache_creation_tokens", 0) or 0 for c in captures)


def count_status(
    captures: list[dict], status: int, source: str | None = None
) -> int:
    return sum(
        1
        for c in captures
        if c.get("response_status") == status
        and (source is None or c.get("status_source") == source)
    )


def count_gate_reason(captures: list[dict], substring: str) -> int:
    return sum(
        1
        for c in captures
        if c.get("gate_reason") and substring in (c.get("gate_reason") or "")
    )


def ttft_stats(captures: list[dict]) -> dict:
    ttfts = [c["ttft_ms"] for c in captures if c.get("ttft_ms")]
    if not ttfts:
        return {"p50": 0, "min": 0, "max": 0, "count": 0}
    return {
        "p50": median(ttfts),
        "min": min(ttfts),
        "max": max(ttfts),
        "count": len(ttfts),
    }


def total_tokens(captures: list[dict]) -> dict:
    return {
        "input": sum(c.get("total_input_tokens", 0) or 0 for c in captures),
        "output": sum(c.get("total_output_tokens", 0) or 0 for c in captures),
        "cache_read": sum(c.get("cache_read_tokens", 0) or 0 for c in captures),
        "cache_creation": sum(c.get("cache_creation_tokens", 0) or 0 for c in captures),
    }


def median_duration_ms(captures: list[dict]) -> float:
    durs = [c.get("duration_ms", 0) or 0 for c in captures if c.get("duration_ms")]
    return median(durs) if durs else 0.0
