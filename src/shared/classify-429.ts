// 429 response classification.

/** Classify a 429 response as concurrency, rate-limit, or gateway-cdn. */
export function classify429(res: Response): "concurrency" | "rate_limit" | "gateway" {
  const server = res.headers.get("server") ?? "";
  if (server.includes("cloudflare") || server.includes("fastly")) return "gateway";
  const ra = res.headers.get("retry-after");
  if (ra && Number(ra) <= 10) return "concurrency";
  return "rate_limit";
}
