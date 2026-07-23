/**
 * Composite gate health badge builder.
 *
 * Computes the merged label, Badge variant, and color className from the
 * admission state (already produced by `computeStatus()` in gate-status.tsx)
 * and an optional most-urgent budget summary. Pure function — no React or
 * DOM dependencies.
 *
 * See `.scratch/gate-health-merged-badge/spec.md` for the full decision set.
 */

import { badgeInfo, badgeSuccess, badgeWarning, budgetTier } from "@/lib/badge-colors";

/** Color tier hierarchy: red > amber > blue > green. */
type Tier = "red" | "amber" | "blue" | "green";

const TIER_RANK: Record<Tier, number> = {
  red: 3,
  amber: 2,
  blue: 1,
  green: 0,
};

/** Color class for each non-red tier. Red uses the destructive variant. */
const TIER_CLASS: Record<Exclude<Tier, "red">, string> = {
  amber: badgeWarning,
  blue: badgeInfo,
  green: badgeSuccess,
};

/** Maps the existing `budgetTier()` result to our internal `Tier` type. */
function budgetTierOf(budget: GateHealthBudget): Tier {
  return budgetTier(budget);
}

export interface GateHealthBudget {
  category: string;
  usedPct: number;
  overBudgetToday: boolean;
}

export interface GateHealthInput {
  /** Admission state label from `computeStatus()` (e.g. "boxed", "demoted", "low", "interactive", "high"). */
  admissionLabel: string;
  /** Optional most-urgent budget summary, already filtered by `usageOk` and `selectMostUrgentBudget()`. */
  budget: GateHealthBudget | null;
}

export interface GateHealthResult {
  label: string;
  variant: "secondary" | "destructive";
  className: string | undefined;
}

/**
 * Admission state tier. `boxed`/`demoted` are red (hard reject / hard degrade),
 * `low` is amber (soft degrade), any other non-`high` label is blue
 * (informational non-normal mode), `high` is green.
 */
function admissionTierOf(label: string): Tier {
  if (label === "boxed" || label === "demoted") return "red";
  if (label === "low") return "amber";
  if (label === "high") return "green";
  return "blue";
}

/** True when budget pressure is actionable (≥80% or over-budget). */
function budgetLeads(budget: GateHealthBudget): boolean {
  return budget.overBudgetToday || budget.usedPct >= 80;
}

/** Returns the most severe tier across all visible segments. */
function worstTier(...tiers: Tier[]): Tier {
  return tiers.reduce((worst, t) => (TIER_RANK[t] > TIER_RANK[worst] ? t : worst), "green");
}

/**
 * Compute the composite gate health badge label, variant, and color class.
 *
 * Label segments are joined with ` · ` (space-middle-dot-space). The worst
 * active segment leads:
 *
 * 1. `boxed` / `demoted` — always lead, red
 * 2. budget ≥80% / over-budget — leads over modes
 * 3. `low` — soft degrade, amber
 * 4. non-normal mode — informational, blue
 * 5. `high` — healthy, green (dropped when budget is present)
 */
export function computeGateHealth(input: GateHealthInput): GateHealthResult {
  const { admissionLabel, budget } = input;

  const admissionTier = admissionTierOf(admissionLabel);

  // Treat budget as absent when usedPct is 0 and not over-budget (spec: budget
  // dropped when 0%/absent). The caller's selectMostUrgentBudget() also filters
  // this, but the guard makes the function safe when called directly.
  const effectiveBudget = budget && (budget.overBudgetToday || budget.usedPct > 0) ? budget : null;
  const bTier = effectiveBudget ? budgetTierOf(effectiveBudget) : null;

  if (effectiveBudget === null) {
    return finalize(admissionLabel, admissionTier, null);
  }

  const budgetSegment = `${effectiveBudget.category} ${effectiveBudget.usedPct}%`;

  if (admissionLabel === "high") {
    return finalize(budgetSegment, admissionTier, bTier);
  }

  const admissionLeads = admissionTier === "red" || !budgetLeads(effectiveBudget);
  const label = admissionLeads
    ? `${admissionLabel} · ${budgetSegment}`
    : `${budgetSegment} · ${admissionLabel}`;

  return finalize(label, admissionTier, bTier);
}

function finalize(label: string, admissionTier: Tier, budgetTier: Tier | null): GateHealthResult {
  const worst = budgetTier ? worstTier(admissionTier, budgetTier) : admissionTier;
  if (worst === "red") {
    return { label, variant: "destructive", className: undefined };
  }
  return { label, variant: "secondary", className: TIER_CLASS[worst] };
}
