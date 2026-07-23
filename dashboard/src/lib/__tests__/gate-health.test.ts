import { describe, expect, it } from "vitest";

import { badgeInfo, badgeSuccess, badgeWarning } from "@/lib/badge-colors";
import { computeGateHealth } from "@/lib/gate-health";

describe("computeGateHealth", () => {
  describe("label composition", () => {
    it("returns 'high' when admission is high and no budget", () => {
      const result = computeGateHealth({ admissionLabel: "high", budget: null });
      expect(result.label).toBe("high");
    });

    it("returns just the budget segment when admission is high and budget present", () => {
      const result = computeGateHealth({
        admissionLabel: "high",
        budget: { category: "frontier", usedPct: 49, overBudgetToday: false },
      });
      expect(result.label).toBe("frontier 49%");
    });

    it("returns just the admission label when degraded and no budget", () => {
      const result = computeGateHealth({ admissionLabel: "interactive", budget: null });
      expect(result.label).toBe("interactive");
    });

    it("appends budget after admission when budget is below 80%", () => {
      const result = computeGateHealth({
        admissionLabel: "interactive",
        budget: { category: "frontier", usedPct: 49, overBudgetToday: false },
      });
      expect(result.label).toBe("interactive · frontier 49%");
    });

    it("leads with budget when budget is at or above 80%", () => {
      const result = computeGateHealth({
        admissionLabel: "interactive",
        budget: { category: "frontier", usedPct: 87, overBudgetToday: false },
      });
      expect(result.label).toBe("frontier 87% · interactive");
    });

    it("leads with boxed over budget regardless of budget pressure", () => {
      const result = computeGateHealth({
        admissionLabel: "boxed",
        budget: { category: "frontier", usedPct: 49, overBudgetToday: false },
      });
      expect(result.label).toBe("boxed · frontier 49%");
    });

    it("returns just 'boxed' when boxed and no budget", () => {
      const result = computeGateHealth({ admissionLabel: "boxed", budget: null });
      expect(result.label).toBe("boxed");
    });

    it("leads with demoted over budget even when budget is pressing", () => {
      const result = computeGateHealth({
        admissionLabel: "demoted",
        budget: { category: "frontier", usedPct: 87, overBudgetToday: false },
      });
      expect(result.label).toBe("demoted · frontier 87%");
    });

    it("leads with budget when low mode and budget is pressing", () => {
      const result = computeGateHealth({
        admissionLabel: "low",
        budget: { category: "frontier", usedPct: 87, overBudgetToday: false },
      });
      expect(result.label).toBe("frontier 87% · low");
    });

    it("leads with budget when over-budget-today even with low usedPct", () => {
      const result = computeGateHealth({
        admissionLabel: "high",
        budget: { category: "frontier", usedPct: 50, overBudgetToday: true },
      });
      expect(result.label).toBe("frontier 50%");
    });

    it("appends budget after low when budget is below 80%", () => {
      const result = computeGateHealth({
        admissionLabel: "low",
        budget: { category: "frontier", usedPct: 49, overBudgetToday: false },
      });
      expect(result.label).toBe("low · frontier 49%");
    });
  });

  describe("variant and color", () => {
    it("uses secondary + badgeSuccess (green) when admission is high and no budget", () => {
      const result = computeGateHealth({ admissionLabel: "high", budget: null });
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeSuccess);
    });

    it("uses secondary + badgeInfo (blue) when admission is high and budget below 80%", () => {
      const result = computeGateHealth({
        admissionLabel: "high",
        budget: { category: "frontier", usedPct: 49, overBudgetToday: false },
      });
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeInfo);
    });

    it("uses secondary + badgeInfo (blue) when degraded admission and no budget", () => {
      const result = computeGateHealth({ admissionLabel: "interactive", budget: null });
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeInfo);
    });

    it("uses secondary + badgeInfo (blue) when both degraded and budget below 80%", () => {
      const result = computeGateHealth({
        admissionLabel: "interactive",
        budget: { category: "frontier", usedPct: 49, overBudgetToday: false },
      });
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeInfo);
    });

    it("uses secondary + badgeWarning (amber) when budget is at or above 80%", () => {
      const result = computeGateHealth({
        admissionLabel: "interactive",
        budget: { category: "frontier", usedPct: 87, overBudgetToday: false },
      });
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeWarning);
    });

    it("uses destructive variant (red) when boxed regardless of budget", () => {
      const result = computeGateHealth({
        admissionLabel: "boxed",
        budget: { category: "frontier", usedPct: 49, overBudgetToday: false },
      });
      expect(result.variant).toBe("destructive");
      expect(result.className).toBeUndefined();
    });

    it("uses destructive variant (red) when boxed and no budget", () => {
      const result = computeGateHealth({ admissionLabel: "boxed", budget: null });
      expect(result.variant).toBe("destructive");
      expect(result.className).toBeUndefined();
    });

    it("uses destructive variant (red) when demoted regardless of budget", () => {
      const result = computeGateHealth({
        admissionLabel: "demoted",
        budget: { category: "frontier", usedPct: 87, overBudgetToday: false },
      });
      expect(result.variant).toBe("destructive");
      expect(result.className).toBeUndefined();
    });

    it("uses secondary + badgeWarning (amber) when low mode and budget pressing (amber is max)", () => {
      const result = computeGateHealth({
        admissionLabel: "low",
        budget: { category: "frontier", usedPct: 87, overBudgetToday: false },
      });
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeWarning);
    });

    it("uses destructive variant (red) when over-budget-today", () => {
      const result = computeGateHealth({
        admissionLabel: "high",
        budget: { category: "frontier", usedPct: 50, overBudgetToday: true },
      });
      expect(result.variant).toBe("destructive");
      expect(result.className).toBeUndefined();
    });

    it("uses secondary + badgeWarning (amber) when low mode and no budget", () => {
      const result = computeGateHealth({ admissionLabel: "low", budget: null });
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeWarning);
    });

    it("uses secondary + badgeWarning (amber) when low mode and budget below 80%", () => {
      const result = computeGateHealth({
        admissionLabel: "low",
        budget: { category: "frontier", usedPct: 49, overBudgetToday: false },
      });
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeWarning);
    });

    it("leads with budget and uses destructive when over-budget with degraded admission", () => {
      const result = computeGateHealth({
        admissionLabel: "interactive",
        budget: { category: "frontier", usedPct: 50, overBudgetToday: true },
      });
      expect(result.label).toBe("frontier 50% · interactive");
      expect(result.variant).toBe("destructive");
      expect(result.className).toBeUndefined();
    });

    it("leads with demoted and uses destructive when over-budget with demoted admission", () => {
      const result = computeGateHealth({
        admissionLabel: "demoted",
        budget: { category: "frontier", usedPct: 50, overBudgetToday: true },
      });
      expect(result.label).toBe("demoted · frontier 50%");
      expect(result.variant).toBe("destructive");
      expect(result.className).toBeUndefined();
    });

    it("treats budget at exactly 80% as amber (budget leads)", () => {
      const result = computeGateHealth({
        admissionLabel: "interactive",
        budget: { category: "frontier", usedPct: 80, overBudgetToday: false },
      });
      expect(result.label).toBe("frontier 80% · interactive");
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeWarning);
    });

    it("treats budget at 79% as blue (admission leads)", () => {
      const result = computeGateHealth({
        admissionLabel: "interactive",
        budget: { category: "frontier", usedPct: 79, overBudgetToday: false },
      });
      expect(result.label).toBe("interactive · frontier 79%");
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeInfo);
    });

    it("drops budget segment when usedPct is 0 and not over-budget (degraded admission)", () => {
      const result = computeGateHealth({
        admissionLabel: "interactive",
        budget: { category: "frontier", usedPct: 0, overBudgetToday: false },
      });
      expect(result.label).toBe("interactive");
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeInfo);
    });

    it("drops budget segment when usedPct is 0 and not over-budget (healthy admission)", () => {
      const result = computeGateHealth({
        admissionLabel: "high",
        budget: { category: "frontier", usedPct: 0, overBudgetToday: false },
      });
      expect(result.label).toBe("high");
      expect(result.variant).toBe("secondary");
      expect(result.className).toBe(badgeSuccess);
    });

    it("still shows budget when usedPct is 0 but over-budget-today", () => {
      const result = computeGateHealth({
        admissionLabel: "high",
        budget: { category: "frontier", usedPct: 0, overBudgetToday: true },
      });
      expect(result.label).toBe("frontier 0%");
      expect(result.variant).toBe("destructive");
      expect(result.className).toBeUndefined();
    });
  });
});
