// Internal numeric helpers for usage extraction.
// Not re-exported by the barrel — internal to the usage module.

import type { UsageMetrics } from "./types.js";

export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function numOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function computeTps(
  output: number | null,
  durationMs: number | null,
  ttftMs: number | null,
): number | null {
  if (output == null || output <= 0) return null;
  if (durationMs == null) return null;
  const genMs = ttftMs != null && ttftMs > 0 ? durationMs - ttftMs : durationMs;
  // Require at least 1 second of generation time — below this the rate is
  // dominated by timing noise and produces nonsensical values (e.g. 44k t/s).
  if (genMs < 1000) return null;
  return (output / genMs) * 1000;
}

export function emptyMetrics(
  provider: "anthropic" | "openai",
  streaming: boolean,
  durationMs: number | null,
): UsageMetrics {
  return {
    provider,
    streaming,
    input_tokens: null,
    output_tokens: null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    total_input_tokens: null,
    total_output_tokens: null,
    thinking_tokens: null,
    ttft_ms: null,
    duration_ms: durationMs,
    tps: null,
    usage_missing: true,
  };
}
