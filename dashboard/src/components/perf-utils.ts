export function fmtMs(v: number | null): string {
  if (v == null) return "—";
  if (v < 1000) return `${Math.round(v)}ms`;
  return `${(v / 1000).toFixed(2)}s`;
}

export function fmtTps(v: number | null): string {
  if (v == null) return "—";
  return v.toFixed(1);
}

export function fmtPct(v: number): string {
  return `${v.toFixed(1)}%`;
}
