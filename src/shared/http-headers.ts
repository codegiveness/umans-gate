// HTTP header utilities.

/** Hop-by-hop headers that must not be forwarded by a proxy. */
export const HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "content-length",
  "host",
]);

/** Convert a Headers object to a plain object (lowercase keys, comma-joined dups). */
export function headersToObject(h: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  h.forEach((v, k) => {
    const lk = k.toLowerCase();
    obj[lk] = obj[lk] === undefined ? v : `${obj[lk]}, ${v}`;
  });
  return obj;
}

/** Header names whose values must never be persisted to storage/dashboard. */
const REDACTED_HEADERS = new Set(["authorization", "x-api-key", "api-key"]);

/** Return a shallow copy of `headers` with sensitive values replaced by "[REDACTED]". */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? "[REDACTED]" : v;
  }
  return out;
}
