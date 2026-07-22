import { describe, expect, it } from "vitest";

import { budgetTier } from "@/lib/badge-colors";

describe("budgetTier", () => {
  it("returns red when overBudgetToday is true", () => {
    expect(budgetTier({ overBudgetToday: true, usedPct: 0 })).toBe("red");
  });

  it("returns red when overBudgetToday is true even with low usedPct", () => {
    expect(budgetTier({ overBudgetToday: true, usedPct: 50 })).toBe("red");
  });

  it("returns amber when usedPct is exactly 80 and not over budget", () => {
    expect(budgetTier({ overBudgetToday: false, usedPct: 80 })).toBe("amber");
  });

  it("returns blue when usedPct is below 80", () => {
    expect(budgetTier({ overBudgetToday: false, usedPct: 79 })).toBe("blue");
  });

  it("returns blue when usedPct is low and not over budget", () => {
    expect(budgetTier({ overBudgetToday: false, usedPct: 0 })).toBe("blue");
  });
});
