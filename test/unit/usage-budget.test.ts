import { expect, test } from "bun:test";
import type { PriorityBudgetEntry } from "../../src/types.js";
import { selectMostUrgentBudget } from "../../src/usage/budget.js";

const entry = (
  category: string,
  usedPct: number,
  overBudgetToday = false,
): PriorityBudgetEntry => ({
  category,
  label: category,
  models: [],
  usedPct,
  overBudgetToday,
  mode: "interactive",
  resetsAt: null,
});

test("returns null for empty array", () => {
  expect(selectMostUrgentBudget([])).toBeNull();
});

test("returns null when all entries have usedPct 0", () => {
  expect(selectMostUrgentBudget([entry("frontier", 0), entry("standard", 0)])).toBeNull();
});

test("returns highest usedPct among non-over-budget entries", () => {
  const result = selectMostUrgentBudget([entry("sonnet", 42), entry("frontier", 87)]);
  expect(result).not.toBeNull();
  expect(result?.category).toBe("frontier");
  expect(result?.usedPct).toBe(87);
});

test("prioritizes over-budget entry over higher usedPct non-over-budget entry", () => {
  const result = selectMostUrgentBudget([
    entry("frontier", 87, false),
    entry("standard", 42, true),
  ]);
  expect(result).not.toBeNull();
  expect(result?.category).toBe("standard");
  expect(result?.overBudgetToday).toBe(true);
});

test("among over-budget entries, picks highest usedPct", () => {
  const result = selectMostUrgentBudget([entry("standard", 30, true), entry("frontier", 95, true)]);
  expect(result).not.toBeNull();
  expect(result?.category).toBe("frontier");
  expect(result?.usedPct).toBe(95);
});

test("returns full entry shape with all fields", () => {
  const input: PriorityBudgetEntry = {
    category: "frontier",
    label: "Frontier models",
    models: ["umans-coder", "umans-glm-5.2"],
    usedPct: 11,
    overBudgetToday: false,
    mode: "interactive",
    resetsAt: null,
  };
  const result = selectMostUrgentBudget([input]);
  expect(result).toEqual(input);
});

test("returns non-zero entry when over-budget entry has usedPct 0", () => {
  const result = selectMostUrgentBudget([entry("frontier", 0, true), entry("standard", 50, false)]);
  expect(result).not.toBeNull();
  expect(result?.category).toBe("frontier");
  expect(result?.usedPct).toBe(0);
  expect(result?.overBudgetToday).toBe(true);
});
