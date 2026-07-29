/**
 * Unified penalty badge builder.
 *
 * Computes the merged label, badge variant/className, severity tier, and
 * structured tooltip data from account-level admission state plus ALL
 * offending priority budget categories. Pure function — no React or DOM
 * dependencies.
 *
 * See `.scratch/unified-penalty-badge/spec.md` and ADR-0025 for the full
 * decision set.
 */

import { fmtDurationUntil } from "@/lib/format";
import type { GateStats, PriorityBudgetEntry, ServiceMode, UsageSnapshot } from "@/types";

/** Color tier hierarchy: red > amber > blue > green. */
export type Tier = "red" | "amber" | "blue" | "green";

const TIER_RANK: Record<Tier, number> = {
  red: 3,
  amber: 2,
  blue: 1,
  green: 0,
};

const LOW_SERVICE_MODES = ["low_interactivity", "low", "degraded"];

const RED_CLASS = "text-destructive";
const AMBER_CLASS = "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
const BLUE_CLASS = "bg-blue-500/10 text-blue-600 dark:text-blue-400";
const GREEN_CLASS =
  "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

export const TIER_CLASS: Record<Tier, string> = {
  red: RED_CLASS,
  amber: AMBER_CLASS,
  blue: BLUE_CLASS,
  green: GREEN_CLASS,
};

/** One budget category input row (widened with `mode` and `models`). */
export interface GateHealthBudget {
  category: string;
  label: string;
  usedPct: number;
  overBudgetToday: boolean;
  mode: string;
  models: string[];
  resetsAt?: number | null;
}

/** Structured tooltip entry for one offending budget category. */
export interface OffendingCategory {
  label: string;
  models: string[];
  usedPct: number;
  mode: string;
  overBudgetToday: boolean;
  resetsAt: number | null;
}

/** Input to `computeGateHealth`. */
export interface GateHealthInput {
  admissionLabel: string;
  budgets: GateHealthBudget[];
  admissionDetail?: string;
  boxed?: boolean;
  boxedReason?: string | null;
  boxedUntil?: number | null;
  unitsDemoted?: boolean;
  demotedUntil?: number | null;
  serviceMode?: { current: string; resetsAt: number | null } | null;
}

/** Structured result consumed by `<PenaltyBadge>`. */
export interface GateHealthResult {
  label: string;
  variant: "secondary" | "destructive";
  className: string;
  tier: Tier;
  offendingCategories: OffendingCategory[];
  admissionDetail?: string;
}

/** A budget category is offending if any amber/red trigger fires. */
function isOffending(b: GateHealthBudget): boolean {
  return b.overBudgetToday || b.mode !== "interactive" || b.usedPct >= 80;
}

function toOffending(b: GateHealthBudget): OffendingCategory {
  return {
    label: b.label,
    models: b.models,
    usedPct: b.usedPct,
    mode: b.mode,
    overBudgetToday: b.overBudgetToday,
    resetsAt: b.resetsAt ?? null,
  };
}

/** Returns the most severe tier across all tiers passed in. */
function worstTier(...tiers: Tier[]): Tier {
  return tiers.reduce((worst, t) => (TIER_RANK[t] > TIER_RANK[worst] ? t : worst), "green");
}

/**
 * Compute the unified penalty badge label, variant, color class, tier, and
 * structured tooltip data from admission state plus ALL budget categories.
 *
 * Tier precedence (red > amber > blue > green):
 * - RED if `boxed`, `unitsDemoted`, or any budget `overBudgetToday`.
 * - AMBER if `priorityLow` (admissionLabel 'low' without boxing), any low
 *   service mode, any budget `mode !== "interactive"`, or any budget
 *   `usedPct >= 80`.
 * - BLUE if a non-normal, non-low service mode is set.
 * - GREEN otherwise.
 */
export function serviceModeTier(snap: UsageSnapshot): Tier {
  if (snap.boxedUntil !== null) return "red";
  if (snap.unitsDemoted) return "red";
  const mode = snap.serviceMode.current;
  if (mode === "normal" || mode === "interactive") {
    return snap.priorityLow ? "amber" : "green";
  }
  if (LOW_SERVICE_MODES.includes(mode) || mode.startsWith("low_")) return "amber";
  return "blue";
}

export function computeGateHealth(input: GateHealthInput): GateHealthResult {
  const offending = input.budgets.filter(isOffending).map(toOffending);

  let tier: Tier = "green";

  // RED: hard blocks
  if (input.boxed || input.unitsDemoted || offending.some((c) => c.overBudgetToday)) {
    tier = "red";
  } else if (
    input.admissionLabel === "low" ||
    (input.serviceMode && LOW_SERVICE_MODES.includes(input.serviceMode.current)) ||
    offending.some((c) => c.mode !== "interactive" || c.usedPct >= 80)
  ) {
    tier = "amber";
  } else if (input.serviceMode && input.serviceMode.current !== "normal") {
    tier = "blue";
  }

  // Fold admission tier (red for boxed/demoted) into worst, then budgets.
  const budgetTier = offending.reduce<Tier>(
    (worst, c) =>
      worstTier(
        worst,
        c.overBudgetToday ? "red" : c.mode !== "interactive" || c.usedPct >= 80 ? "amber" : "green",
      ),
    "green",
  );
  tier = worstTier(tier, budgetTier);

  const label = buildLabel(input, offending);
  return {
    label,
    variant: tier === "red" ? "destructive" : "secondary",
    className: TIER_CLASS[tier],
    tier,
    offendingCategories: offending,
    admissionDetail: input.admissionDetail,
  };
}

function buildLabel(input: GateHealthInput, offending: OffendingCategory[]): string {
  if (input.boxed) {
    const resetText = fmtDurationUntil(input.boxedUntil ?? null);
    return resetText ? `boxed · resets ${resetText}` : "boxed";
  }
  if (input.unitsDemoted) {
    const resetText = fmtDurationUntil(input.demotedUntil ?? null);
    return resetText ? `demoted · resets ${resetText}` : "demoted";
  }
  if (offending.length > 0) {
    const sorted = [...offending].sort((a, b) => {
      const aRed = a.overBudgetToday ? 1 : 0;
      const bRed = b.overBudgetToday ? 1 : 0;
      if (aRed !== bRed) return bRed - aRed;
      return b.usedPct - a.usedPct;
    });
    const head = sorted.slice(0, 2).map((c) => `${c.label} ${c.usedPct}%`);
    const more = sorted.length > 2 ? ` +${sorted.length - 2}` : "";
    return `${head.join(", ")}${more}`;
  }
  if (input.admissionLabel !== "high") {
    return input.admissionLabel;
  }
  return "healthy";
}

/**
 * Derive admission label from gate stats. `boxed`/`demoted` lead (red);
 * low service modes and `priorityLow` are amber; other non-normal service
 * modes use the mode name (blue); otherwise `high`.
 */
function admissionLabelFromGateStats(stats: GateStats): string {
  if (stats.boxed) return "boxed";
  if (stats.unitsDemoted) return "demoted";
  const mode = stats.serviceMode.current;
  if (mode !== "normal" && LOW_SERVICE_MODES.includes(mode)) return "low";
  if (mode !== "normal") return mode.startsWith("low_") ? "low" : mode;
  if (stats.priorityLow) return "low";
  return "high";
}

function admissionLabelFromUsageSnapshot(snap: UsageSnapshot): string {
  if (snap.boxedUntil !== null) return "boxed";
  if (snap.unitsDemoted) return "demoted";
  const mode = snap.serviceMode.current;
  if (mode !== "normal" && LOW_SERVICE_MODES.includes(mode)) return "low";
  if (mode !== "normal") return mode.startsWith("low_") ? "low" : mode;
  if (snap.priorityLow) return "low";
  return "high";
}

function mapBudgetEntry(entry: PriorityBudgetEntry): GateHealthBudget {
  return {
    category: entry.category,
    label: entry.label,
    usedPct: entry.usedPct,
    overBudgetToday: entry.overBudgetToday,
    mode: entry.mode,
    models: entry.models,
    resetsAt: entry.resetsAt,
  };
}

/**
 * Build the admission detail string for the tooltip, mirroring the old
 * `computeStatus().detail` text so existing tooltip assertions stay valid.
 * Returns undefined when admission is "high" (detail dropped).
 */
function buildAdmissionDetail(
  label: string,
  boxedReason: string | null,
  serviceModeCurrent: string,
): string | undefined {
  if (label === "boxed") {
    return boxedReason ? `boxed: ${boxedReason}` : "boxed by upstream";
  }
  if (label === "demoted") {
    return "units demoted by upstream";
  }
  if (label === "low") {
    if (serviceModeCurrent !== "normal" && LOW_SERVICE_MODES.includes(serviceModeCurrent)) {
      return `service mode: ${serviceModeCurrent}`;
    }
    return "priority low";
  }
  if (serviceModeCurrent !== "normal") {
    return `service mode: ${serviceModeCurrent}`;
  }
  return undefined;
}

/**
 * Build the badge input by merging admission state from `GateStats`
 * (WebSocket, real-time) with the budget array from `UsageSnapshot`
 * (polled, complete).
 *
 * - Admission fields prefer `GateStats`; fall back to `UsageSnapshot` when
 *   `GateStats` is null.
 * - Budgets prefer `UsageSnapshot.priorityBudget`; fall back to
 *   `GateStats.priorityBudgetSummary` as a single-element array when
 *   `UsageSnapshot` is null.
 * - When both inputs are null, returns null and `<PenaltyBadge>` renders
 *   nothing.
 */
export function mergePenaltyInput(
  gateStats: GateStats | null,
  usageSnapshot: UsageSnapshot | null,
): GateHealthInput | null {
  if (gateStats === null && usageSnapshot === null) return null;

  const admissionLabel = gateStats
    ? admissionLabelFromGateStats(gateStats)
    : usageSnapshot
      ? admissionLabelFromUsageSnapshot(usageSnapshot)
      : "high";

  const boxed = gateStats
    ? gateStats.boxed
    : usageSnapshot
      ? usageSnapshot.boxedUntil !== null
      : false;
  const boxedReason = gateStats
    ? gateStats.boxedReason
    : usageSnapshot
      ? usageSnapshot.boxedReason
      : null;
  const boxedUntil = gateStats
    ? gateStats.boxedUntil
    : usageSnapshot
      ? usageSnapshot.boxedUntil
      : null;
  const unitsDemoted = gateStats
    ? gateStats.unitsDemoted
    : usageSnapshot
      ? usageSnapshot.unitsDemoted
      : false;
  const demotedUntil = gateStats
    ? gateStats.demotedUntil
    : usageSnapshot
      ? usageSnapshot.demotedUntil
      : null;
  const serviceMode: ServiceMode | null = gateStats
    ? gateStats.serviceMode
    : usageSnapshot
      ? usageSnapshot.serviceMode
      : null;

  const admissionDetail = buildAdmissionDetail(
    admissionLabel,
    boxedReason,
    serviceMode?.current ?? "normal",
  );

  let budgets: GateHealthBudget[];
  if (usageSnapshot && usageSnapshot.priorityBudget.length > 0) {
    budgets = usageSnapshot.priorityBudget.map(mapBudgetEntry);
  } else if (gateStats?.usageOk && gateStats.priorityBudgetSummary) {
    const s = gateStats.priorityBudgetSummary;
    budgets = [
      {
        category: s.category,
        label: s.label,
        usedPct: s.usedPct,
        overBudgetToday: s.overBudgetToday,
        mode: s.mode,
        models: s.models,
        resetsAt: s.resetsAt,
      },
    ];
  } else {
    budgets = [];
  }

  return {
    admissionLabel,
    budgets,
    admissionDetail,
    boxed,
    boxedReason,
    boxedUntil,
    unitsDemoted,
    demotedUntil,
    serviceMode,
  };
}
