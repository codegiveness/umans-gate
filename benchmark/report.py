"""Render comparison tables as stdout + markdown."""

import json
import time


def render_table(benchmark_name: str, headers: list[str], rows: list[list]) -> str:
    """Render a markdown table."""
    lines = [f"## {benchmark_name}", ""]
    lines.append("| " + " | ".join(headers) + " |")
    lines.append("| " + " | ".join("---" for _ in headers) + " |")
    for row in rows:
        lines.append("| " + " | ".join(str(c) for c in row) + " |")
    lines.append("")
    return "\n".join(lines)


def render_results(results: dict) -> str:
    """Render full results dict as JSON + markdown."""
    lines = [
        f"<!-- Generated: {time.strftime('%Y-%m-%d %H:%M:%S')} -->",
        "",
        "```json",
        json.dumps(results, indent=2, default=str),
        "```",
        "",
    ]
    return "\n".join(lines)
