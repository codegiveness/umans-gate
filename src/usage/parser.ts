// Raw upstream /v1/usage response parsing + snapshot construction.
// Pure functions: no I/O, no mutation. Reusable by aggregator + reconciler.

import type { UsageSnapshot } from "../types.js";

/** Raw shape of the upstream /v1/usage response. */
export interface RawUsage {
  plan?: { display_name?: string };
  limits?: {
    requests?: { limit?: number; hard_cap?: number; burst_pct?: number; window_seconds?: number };
    concurrency?: { limit?: number; hard_cap?: number; burst_pct?: number };
  };
  usage?: {
    requests_in_window?: number;
    remaining_requests?: number;
    concurrent_sessions?: number;
    tokens_in?: number;
    tokens_out?: number;
    priority?: {
      low?: boolean;
      boxed_until?: number | null;
      reason?: string | null;
      units_demoted?: boolean;
      demoted_until?: number | null;
    };
  };
}

/** Classify a plan display name into one of the known tiers.
 *  Uses substring matching so variants like "Code Max (Founding Seat)"
 *  still resolve to "Code Max". */
function classifyPlan(name: string | undefined): "Code Pro" | "Code Max" | "unknown" {
  if (!name) return "unknown";
  const lower = name.toLowerCase();
  if (lower.includes("code max")) return "Code Max";
  if (lower.includes("code pro")) return "Code Pro";
  return "unknown";
}

/** Build a UsageSnapshot from a parsed raw response.
 *  Carries forward last-known concurrency limits when the upstream omits them. */
export function buildSnapshot(
  raw: RawUsage,
  ok: boolean,
  lastConcurrencyHardCap: number,
  lastConcurrencySoftLimit: number,
): UsageSnapshot {
  const planName = raw.plan?.display_name;
  const plan = classifyPlan(planName);
  return {
    ok,
    fetchedAt: Date.now(),
    plan,
    requestsLimit: raw.limits?.requests?.limit ?? null,
    requestsHardCap: raw.limits?.requests?.hard_cap ?? null,
    requestsWindowSeconds: raw.limits?.requests?.window_seconds ?? null,
    concurrencySoftLimit: raw.limits?.concurrency?.limit ?? lastConcurrencySoftLimit,
    concurrencyHardCap: raw.limits?.concurrency?.hard_cap ?? lastConcurrencyHardCap,
    requestsInWindow: raw.usage?.requests_in_window ?? 0,
    requestsRemaining: raw.usage?.remaining_requests ?? null,
    concurrentSessions: raw.usage?.concurrent_sessions ?? 0,
    priorityLow: raw.usage?.priority?.low ?? false,
    boxedUntil: raw.usage?.priority?.boxed_until ?? null,
    boxedReason: raw.usage?.priority?.reason ?? null,
    unitsDemoted: raw.usage?.priority?.units_demoted ?? false,
    demotedUntil: raw.usage?.priority?.demoted_until ?? null,
  };
}

/** Fail-safe worst-case snapshot used when no data is available.
 *  Assumes at hard cap, priority low — the most conservative posture. */
export function failSafeSnapshot(): UsageSnapshot {
  return {
    ok: false,
    fetchedAt: 0,
    plan: "unknown",
    requestsLimit: null,
    requestsHardCap: null,
    requestsWindowSeconds: null,
    concurrencySoftLimit: 1,
    concurrencyHardCap: 1,
    requestsInWindow: 0,
    requestsRemaining: null,
    concurrentSessions: 0,
    priorityLow: true,
    boxedUntil: null,
    boxedReason: null,
    unitsDemoted: false,
    demotedUntil: null,
  };
}
