/**
 * Shadcn custom color class strings for semantic Badge usage.
 *
 * Follows the shadcn Badge Custom Colors pattern: Tailwind palette
 * classes applied directly via className, overriding the stock variant.
 * https://ui.shadcn.com/docs/components/base/badge#custom-colors
 */

/** Success — active, healthy, completed states. */
export const badgeSuccess =
  "border-transparent bg-green-100 dark:bg-green-800 text-green-900 dark:text-green-100";

/** Warning — stale, degraded, reconnecting states. */
export const badgeWarning =
  "border-transparent bg-amber-100 dark:bg-amber-800 text-amber-900 dark:text-amber-100";

/** Gold — highest/premium tier. */
export const badgeGold =
  "border-transparent bg-yellow-200 dark:bg-yellow-700 text-yellow-900 dark:text-yellow-50";

/** Info — queued, waiting, informational states. */
export const badgeInfo =
  "border-transparent bg-blue-100 dark:bg-blue-800 text-blue-900 dark:text-blue-100";

/** Violet — tier 2, mid-high wallet tier. */
export const badgeViolet =
  "border-transparent bg-violet-100 dark:bg-violet-800 text-violet-900 dark:text-violet-100";

/** Dot color for success indicators (e.g. WebSocket live dot). */
export const dotSuccess = "bg-green-500 dark:bg-green-400";

/** Dot color for warning indicators (e.g. WebSocket reconnecting dot). */
export const dotWarning = "bg-amber-500 dark:bg-amber-400";

/**
 * Responsible-party badge colors for the Incidents tab.
 * Hue mapping per spec: upstream = 200° (chart-2 cyan), proxy = 30°
 * (chart-3 amber), client = 340° (chart-4 rose).
 */
export const badgeUpstream =
  "border-transparent bg-cyan-100 dark:bg-cyan-900 text-cyan-900 dark:text-cyan-100";
export const badgeProxy =
  "border-transparent bg-amber-100 dark:bg-amber-900 text-amber-900 dark:text-amber-100";
export const badgeClient =
  "border-transparent bg-rose-100 dark:bg-rose-900 text-rose-900 dark:text-rose-100";

export function budgetTier(entry: {
  overBudgetToday: boolean;
  usedPct: number;
}): "blue" | "amber" | "red" {
  if (entry.overBudgetToday) return "red";
  if (entry.usedPct >= 80) return "amber";
  return "blue";
}
