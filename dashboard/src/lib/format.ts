export function fmtSize(n: number | null | undefined): string {
  const value = n ?? 0;
  if (value === 0) return "0 B";
  if (value < 1024) return `${value} B`;
  if (value < 1048576) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1048576).toFixed(2)} MB`;
}

export function fmtTokensCompact(n: number | null | undefined): string {
  const value = n ?? 0;
  if (value === 0) return "0";
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  return `${(value / 1_000_000_000).toFixed(2)}B`;
}

export function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function fmtTtft(ms: number | null | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

export function fmtTps(tps: number | null | undefined): string {
  if (tps == null) return "—";
  return `${tps.toFixed(1)}`;
}

export function fmtCachePct(
  captured: number | null | undefined,
  total: number | null | undefined,
): string {
  const c = captured ?? 0;
  const t = total ?? 0;
  if (t <= 0) return "—";
  const pct = (c / t) * 100;
  return `${pct.toFixed(0)}%`;
}

export function fmtDate(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleTimeString([], { hour12: false }) : "";
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return "";
  return new Date(ts).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function escapeHtml(s: string | null | undefined): string {
  return (s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

export function statusClass(s: number | null | undefined): "ok" | "info" | "warn" | "err" | "" {
  if (!s) return "";
  if (s < 300) return "ok";
  if (s < 400) return "info";
  if (s < 500) return "warn";
  return "err";
}

export function safeParseHeaders(raw: string | null | undefined): Record<string, string> {
  try {
    const parsed = JSON.parse(raw ?? "{}") as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

export function syntaxHighlight(json: string): string {
  return escapeHtml(json);
}

interface CacheTtlInfo {
  count: number;
  ttl: string | null;
}

export function extractCacheTtl(body: string | null | undefined): CacheTtlInfo | null {
  if (!body) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;

  const obj = parsed as { system?: unknown; messages?: Array<{ content?: unknown }> };
  let count = 0;
  let ttl: string | null = null;

  const scan = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks) {
      const cc = (b as { cache_control?: { type?: string; ttl?: string } })?.cache_control;
      if (cc?.type === "ephemeral") {
        count++;
        if (cc.ttl && !ttl) ttl = cc.ttl;
      }
    }
  };

  scan(obj.system);
  for (const m of obj.messages ?? []) scan(m?.content);

  return count > 0 ? { count, ttl } : null;
}
