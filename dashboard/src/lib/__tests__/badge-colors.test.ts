import { describe, expect, it } from "vitest";

import { badgeGold, badgeInfo, badgeSuccess, badgeWarning, budgetTier } from "@/lib/badge-colors";

// ─── Light-theme Badge Tint Tier (ADR 0012) ───
// Light-theme badge backgrounds use *-100 (gold *-200) for figure-ground
// separation from white. Text stays *-900. Dark-theme classes unchanged.

describe("badge light-theme tint tiers", () => {
  it("badgeSuccess uses green-100 bg (not green-50)", () => {
    expect(badgeSuccess).toContain("bg-green-100");
    expect(badgeSuccess).not.toContain("bg-green-50");
  });

  it("badgeWarning uses amber-100 bg (not amber-50)", () => {
    expect(badgeWarning).toContain("bg-amber-100");
    expect(badgeWarning).not.toContain("bg-amber-50");
  });

  it("badgeInfo uses blue-100 bg (not blue-50)", () => {
    expect(badgeInfo).toContain("bg-blue-100");
    expect(badgeInfo).not.toContain("bg-blue-50");
  });

  it("badgeGold uses yellow-200 bg (not yellow-100)", () => {
    expect(badgeGold).toContain("bg-yellow-200");
    expect(badgeGold).not.toContain("bg-yellow-100");
  });

  it("all badge text shades remain *-900", () => {
    expect(badgeSuccess).toContain("text-green-900");
    expect(badgeWarning).toContain("text-amber-900");
    expect(badgeInfo).toContain("text-blue-900");
    expect(badgeGold).toContain("text-yellow-900");
  });

  it("all dark-theme bg classes remain *-800 (gold *-700)", () => {
    expect(badgeSuccess).toContain("dark:bg-green-800");
    expect(badgeWarning).toContain("dark:bg-amber-800");
    expect(badgeInfo).toContain("dark:bg-blue-800");
    expect(badgeGold).toContain("dark:bg-yellow-700");
  });

  it("all dark-theme text classes remain *-100 (gold *-50)", () => {
    expect(badgeSuccess).toContain("dark:text-green-100");
    expect(badgeWarning).toContain("dark:text-amber-100");
    expect(badgeInfo).toContain("dark:text-blue-100");
    expect(badgeGold).toContain("dark:text-yellow-50");
  });
});

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
