// One-shot /v1/usage fetches for limit reconciliation.
// Used by proxy startup + config validation to compare source-of-truth limits
// against cached/captured values. Does NOT touch live snapshot state.

import { fetchUsageRaw } from "./fetch-usage.js";

export type ConcurrencyLimitResult =
  | { ok: true; hardCap: number; softLimit: number }
  | { ok: false; error: string };

export type RequestsLimitResult =
  | { ok: true; limit: number | null; hardCap: number | null; windowSeconds: number | null }
  | { ok: false; error: string };

/** One-shot fetch of /v1/usage to extract concurrency hard_cap + soft_limit.
 *  Does NOT update live snapshot. */
export async function fetchConcurrencyLimits(
  target: string,
  apiKey: string | null,
): Promise<ConcurrencyLimitResult> {
  const result = await fetchUsageRaw(target, apiKey);
  if (!result.ok) return { ok: false, error: result.error };
  const hardCap = Math.max(1, Math.floor(Number(result.data.limits?.concurrency?.hard_cap ?? 1)));
  const softLimit = Math.max(1, Math.floor(Number(result.data.limits?.concurrency?.limit ?? 1)));
  return { ok: true, hardCap, softLimit };
}

/** One-shot fetch of /v1/usage to extract requests limits for rate_limit_requests validation.
 *  Returns {limit, hardCap, windowSeconds} or null if not set (unlimited). */
export async function fetchRequestsLimits(
  target: string,
  apiKey: string | null,
): Promise<RequestsLimitResult> {
  const result = await fetchUsageRaw(target, apiKey);
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    limit: result.data.limits?.requests?.limit ?? null,
    hardCap: result.data.limits?.requests?.hard_cap ?? null,
    windowSeconds: result.data.limits?.requests?.window_seconds ?? null,
  };
}
