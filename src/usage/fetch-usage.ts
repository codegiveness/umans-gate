// Shared /v1/usage fetch helper.
// Consolidates duplicated fetch+parse+error handling between reconciler and aggregator.

import type { RawUsage } from "./parser.js";

const USAGE_PATH = "/v1/usage";

export type { RawUsage };

export type FetchUsageResult = { ok: true; data: RawUsage } | { ok: false; error: string };

/** Shared raw fetch of the upstream /v1/usage endpoint.
 *  Preserves the exact request shape used by callers: GET, no query params,
 *  and an `authorization: Bearer <apiKey>` header when an API key is provided. */
export async function fetchUsageRaw(
  target: string,
  apiKey: string | null,
  signal?: AbortSignal,
): Promise<FetchUsageResult> {
  if (!apiKey) return { ok: false, error: "umans_api_key not set" };
  try {
    const timeoutSignal = AbortSignal.timeout(15000);
    const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    const res = await fetch(`${target}${USAGE_PATH}`, {
      method: "GET",
      headers: { authorization: `Bearer ${apiKey}` },
      signal: fetchSignal,
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const data = (await res.json()) as RawUsage;
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
