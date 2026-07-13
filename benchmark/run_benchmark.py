"""Run a single benchmark by name. Entry point."""

import sys

from benchmarks.b1_ttl_stamping import run as b1
from benchmarks.b2_concurrency_gate import run as b2
from benchmarks.b3_rate_limiter import run as b3
from benchmarks.b4_vision_handoff import run as b4
from benchmarks.b5_circuit_breaker import run as b5
from benchmarks.b6_connection_warmer import run as b6
from benchmarks.b7_prefix_stability import run as b7

BENCHMARKS = {
    "b1": b1,
    "b2": b2,
    "b3": b3,
    "b4": b4,
    "b5": b5,
    "b6": b6,
    "b7": b7,
}


def _save_result(name: str, result: dict):
    import json
    import os
    results_dir = os.path.join(os.path.dirname(__file__), "..", ".omo", "results")
    os.makedirs(results_dir, exist_ok=True)
    path = os.path.join(results_dir, f"{name}_result.json")
    with open(path, "w") as f:
        json.dump(result, f, indent=2, default=str)
    print(f"Saved to {path}")


def main():
    if len(sys.argv) < 2:
        print("Usage: python run_benchmark.py <b1|b2|...|b7|all> [iterations]")
        sys.exit(1)
    name = sys.argv[1]
    iters = int(sys.argv[2]) if len(sys.argv) > 2 else 3
    if name == "all":
        results = {}
        for k, fn in BENCHMARKS.items():
            print(f"\n{'='*60}")
            print(f"Running {k}...")
            print(f"{'='*60}")
            result = fn(iters)
            results[k] = result
            _save_result(k, result)
        print("\n\n=== ALL RESULTS ===")
        import json
        print(json.dumps(results, indent=2, default=str))
    elif name in BENCHMARKS:
        result = BENCHMARKS[name](iters)
        _save_result(name, result)
        import json
        print(json.dumps(result, indent=2, default=str))
    else:
        print(f"Unknown benchmark: {name}. Available: {list(BENCHMARKS.keys())}")
        sys.exit(1)


if __name__ == "__main__":
    main()
