// Dashboard: per-model attribution + percentile stats.
//
// These utilities support a dashboard that shows the latest N requests (default 100)
// per model, with p10/p50/p95 percentiles on TTFT, TPS, input/output/cache tokens.
// They operate on arrays of UsageMetrics + model metadata.

import type { ModelRequestRow, ModelSummary, PercentileStat } from "./types.js";

/**
 * Compute percentile using nearest-rank method (matches SQLite percentile_cont approximation).
 * p ∈ [0, 100]. Returns 0 for empty arrays.
 *
 * Formula: rank = ceil((p/100) * n), clamped to [1, n]; value = sorted[rank-1].
 */
export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 1) return sorted[0];
  const rank = Math.min(Math.max(Math.ceil((p / 100) * n), 1), n);
  return sorted[rank - 1];
}

/** Compute full percentile stats for an array of numbers. Returns null if all null. */
export function computePercentileStats(values: Array<number | null>): PercentileStat | null {
  const nums = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (nums.length === 0) return null;
  const sum = nums.reduce((s, v) => s + v, 0);
  return {
    count: nums.length,
    min: Math.min(...nums),
    p10: percentile(nums, 10),
    p50: percentile(nums, 50),
    p95: percentile(nums, 95),
    max: Math.max(...nums),
    mean: sum / nums.length,
  };
}

/**
 * Group request rows by model, then take the latest N per model (by captured_at desc),
 * and compute percentile summaries for each model.
 */
export function summarizeByModel(rows: ModelRequestRow[], latestN = 100): ModelSummary[] {
  const byModel = new Map<string, ModelRequestRow[]>();
  for (const row of rows) {
    const arr = byModel.get(row.model) ?? [];
    arr.push(row);
    byModel.set(row.model, arr);
  }

  const summaries: ModelSummary[] = [];
  for (const [model, modelRows] of byModel) {
    // Sort by captured_at descending, take latest N
    const sorted = [...modelRows].sort((a, b) => b.captured_at - a.captured_at);
    const latest = sorted.slice(0, latestN);
    const metrics = latest.map((r) => r.metrics);

    const provider = latest[0]?.provider ?? "anthropic";
    const streamingCount = metrics.filter((m) => m.streaming).length;
    const usageMissingCount = metrics.filter((m) => m.usage_missing).length;

    summaries.push({
      model,
      provider,
      request_count: latest.length,
      streaming_count: streamingCount,
      non_streaming_count: latest.length - streamingCount,
      usage_missing_count: usageMissingCount,
      ttft_ms: computePercentileStats(metrics.map((m) => m.ttft_ms)),
      tps: computePercentileStats(metrics.map((m) => m.tps)),
      duration_ms: computePercentileStats(metrics.map((m) => m.duration_ms)),
      input_tokens: computePercentileStats(metrics.map((m) => m.input_tokens)),
      output_tokens: computePercentileStats(metrics.map((m) => m.output_tokens)),
      cache_creation_tokens: computePercentileStats(metrics.map((m) => m.cache_creation_tokens)),
      cache_read_tokens: computePercentileStats(metrics.map((m) => m.cache_read_tokens)),
      total_input_tokens: computePercentileStats(metrics.map((m) => m.total_input_tokens)),
      total_output_tokens: computePercentileStats(metrics.map((m) => m.total_output_tokens)),
    });
  }

  return summaries.sort((a, b) => b.request_count - a.request_count);
}
