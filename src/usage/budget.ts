import type { PriorityBudgetEntry, PriorityBudgetSummary } from "../types.js";

export type { PriorityBudgetEntry, PriorityBudgetSummary } from "../types.js";

export function selectMostUrgentBudget(
  entries: PriorityBudgetEntry[],
): PriorityBudgetSummary | null {
  if (entries.length === 0) return null;
  const sorted = [...entries].sort((a, b) => {
    if (a.overBudgetToday !== b.overBudgetToday) {
      return a.overBudgetToday ? -1 : 1;
    }
    return b.usedPct - a.usedPct;
  });
  if (entries.every((e) => e.usedPct === 0)) return null;
  const top = sorted[0];
  return {
    category: top.category,
    label: top.label,
    models: top.models,
    usedPct: top.usedPct,
    overBudgetToday: top.overBudgetToday,
    mode: top.mode,
    resetsAt: top.resetsAt,
  };
}
