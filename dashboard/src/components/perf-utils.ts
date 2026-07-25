export function fmtMs(v: number | null): string {
  if (v == null) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}

export function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}

/** Format an average value in ms (e.g. "500ms" or "1.50s"). */
export function fmtAvgMs(mean: number | null): string {
  return fmtMs(mean);
}

/** Format a max value in ms (e.g. "800ms" or "1.50s"). */
export function fmtMaxMs(max: number | null): string {
  return fmtMs(max);
}

/** Format an average value in TPS (e.g. "22.0"). */
export function fmtAvgTps(mean: number | null): string {
  if (mean == null) return "—";
  return mean.toFixed(1);
}

/** Format a min value in TPS (e.g. "12.0"). */
export function fmtMinTps(min: number | null): string {
  if (min == null) return "—";
  return min.toFixed(1);
}

/** Small "avg" label shown next to the primary average value. */
export function fmtAvgLabel(mean: number | null): string | undefined {
  return mean == null ? undefined : "AVG";
}

/** Small "max" label shown next to the TTFT max value. */
export function fmtMaxLabel(max: number | null): string | undefined {
  return max == null ? undefined : "MAX";
}

/** Small "min" label shown next to the TPS min value. */
export function fmtMinLabel(min: number | null): string | undefined {
  return min == null ? undefined : "MIN";
}

/** Format percentile sub-line (e.g. "p10: 80ms · p50: 250ms · p95: 480ms"). */
export function fmtPercentiles(p10: number | null, p50: number | null, p95: number | null): string {
  const parts: string[] = [];
  if (p10 != null) parts.push(`p10: ${fmtMs(p10)}`);
  if (p50 != null) parts.push(`p50: ${fmtMs(p50)}`);
  if (p95 != null) parts.push(`p95: ${fmtMs(p95)}`);
  return parts.join(" · ") || "—";
}

/** Format the thinking-to-output ratio as a percentage (e.g. "25.0%").
 *  Returns undefined when thinking or output is zero/absent, so the caller
 *  can omit the annotation entirely. Delegates to fmtPct for one-decimal
 *  consistency with the Cache Hit tile. */
export function fmtThinkingPct(thinking: number, output: number): string | undefined {
  if (thinking <= 0 || output <= 0) return undefined;
  return fmtPct((thinking / output) * 100);
}

/** Format TPS percentile sub-line (e.g. "p10: 12.0 · p50: 22.0 · p95: 30.0"). */
export function fmtTpsPercentiles(
  p10: number | null,
  p50: number | null,
  p95: number | null,
): string {
  const parts: string[] = [];
  if (p10 != null) parts.push(`p10: ${p10.toFixed(1)}`);
  if (p50 != null) parts.push(`p50: ${p50.toFixed(1)}`);
  if (p95 != null) parts.push(`p95: ${p95.toFixed(1)}`);
  return parts.join(" · ") || "—";
}
