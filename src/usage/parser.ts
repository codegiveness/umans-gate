// Raw upstream /v1/usage response parsing + snapshot construction.
// Pure functions: no I/O, no mutation. Reusable by aggregator + reconciler.

import type { PriorityBudgetEntry, UsageSnapshot } from "../types.js";

export interface RawPriorityBudgetEntry {
  category: string;
  label: string;
  models: string[];
  used_pct: number;
  over_budget_today: boolean;
  mode: string;
  resets_at: string | number | null;
}

/** Raw shape of the upstream /v1/usage response.
 *  Date fields (boxed_until, demoted_until, resets_at, window.started_at,
 *  window.resets_at) arrive as ISO 8601 strings and are converted to epoch
 *  ms by buildSnapshot via toEpochMs. */
export interface RawUsage {
  user_id?: string;
  plan?: { display_name?: string; slug?: string };
  limits?: {
    requests?: {
      limit?: number | null;
      hard_cap?: number | null;
      burst_pct?: number;
      window_seconds?: number;
      description?: string;
    };
    concurrency?: { limit?: number; hard_cap?: number; burst_pct?: number; description?: string };
  };
  window?: {
    started_at?: string;
    resets_at?: string;
    remaining_minutes?: number;
  };
  usage?: {
    requests_in_window?: number;
    weighted_in_window?: number;
    remaining_requests?: number | null;
    weighted_remaining_requests?: number | null;
    concurrent_sessions?: number;
    weighted_concurrent_sessions?: number;
    tokens_in?: number;
    tokens_out?: number;
    tokens_cached?: number;
    priority?: {
      low?: boolean;
      boxed_until?: string | number | null;
      reason?: string | null;
      units_demoted?: boolean;
      demoted_until?: string | number | null;
    };
    service_mode?: {
      current?: string;
      resets_at?: string | number | null;
    };
    priority_budget?: RawPriorityBudgetEntry[];
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

/** Convert a raw date value (ISO string or epoch number) to epoch ms.
 *  Returns null for null/undefined/invalid values. */
function toEpochMs(v: string | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : ms;
}

function mapPriorityBudget(raw: RawPriorityBudgetEntry[] | undefined): PriorityBudgetEntry[] {
  if (!raw) return [];
  return raw.map((e) => ({
    category: e.category,
    label: e.label,
    models: e.models,
    usedPct: e.used_pct,
    overBudgetToday: e.over_budget_today,
    mode: e.mode,
    resetsAt: toEpochMs(e.resets_at),
  }));
}

/** Build a UsageSnapshot from a parsed raw response.
 *  Carries forward last-known concurrency limits when the upstream omits them.
 *  Converts ISO date strings to epoch ms for all date fields. */
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
    userId: raw.user_id ?? null,
    plan,
    planSlug: raw.plan?.slug ?? null,
    requestsLimit: raw.limits?.requests?.limit ?? null,
    requestsHardCap: raw.limits?.requests?.hard_cap ?? null,
    requestsWindowSeconds: raw.limits?.requests?.window_seconds ?? null,
    concurrencySoftLimit: raw.limits?.concurrency?.limit ?? lastConcurrencySoftLimit,
    concurrencyHardCap: raw.limits?.concurrency?.hard_cap ?? lastConcurrencyHardCap,
    requestsInWindow: raw.usage?.requests_in_window ?? 0,
    weightedRequestsInWindow: raw.usage?.weighted_in_window ?? 0,
    requestsRemaining: raw.usage?.remaining_requests ?? null,
    weightedRemainingRequests: raw.usage?.weighted_remaining_requests ?? null,
    concurrentSessions: raw.usage?.concurrent_sessions ?? 0,
    weightedConcurrentSessions: raw.usage?.weighted_concurrent_sessions ?? 0,
    tokensIn: raw.usage?.tokens_in ?? 0,
    tokensOut: raw.usage?.tokens_out ?? 0,
    tokensCached: raw.usage?.tokens_cached ?? 0,
    windowStartedAt: toEpochMs(raw.window?.started_at),
    windowResetsAt: toEpochMs(raw.window?.resets_at),
    windowRemainingMinutes: raw.window?.remaining_minutes ?? null,
    priorityLow: raw.usage?.priority?.low ?? false,
    boxedUntil: toEpochMs(raw.usage?.priority?.boxed_until),
    boxedReason: raw.usage?.priority?.reason ?? null,
    unitsDemoted: raw.usage?.priority?.units_demoted ?? false,
    demotedUntil: toEpochMs(raw.usage?.priority?.demoted_until),
    serviceMode: {
      current: raw.usage?.service_mode?.current ?? "normal",
      resetsAt: toEpochMs(raw.usage?.service_mode?.resets_at),
    },
    priorityBudget: mapPriorityBudget(raw.usage?.priority_budget),
  };
}

/** Fail-safe worst-case snapshot used when no data is available.
 *  Assumes at hard cap, priority low — the most conservative posture. */
export function failSafeSnapshot(): UsageSnapshot {
  return {
    ok: false,
    fetchedAt: 0,
    userId: null,
    plan: "unknown",
    planSlug: null,
    requestsLimit: null,
    requestsHardCap: null,
    requestsWindowSeconds: null,
    concurrencySoftLimit: 1,
    concurrencyHardCap: 1,
    requestsInWindow: 0,
    weightedRequestsInWindow: 0,
    requestsRemaining: null,
    weightedRemainingRequests: null,
    concurrentSessions: 0,
    weightedConcurrentSessions: 0,
    tokensIn: 0,
    tokensOut: 0,
    tokensCached: 0,
    windowStartedAt: null,
    windowResetsAt: null,
    windowRemainingMinutes: null,
    priorityLow: true,
    boxedUntil: null,
    boxedReason: null,
    unitsDemoted: false,
    demotedUntil: null,
    serviceMode: { current: "normal", resetsAt: null },
    priorityBudget: [],
  };
}
