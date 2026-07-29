import { describe, expect, it } from "vitest";

import { serviceModeTier, TIER_CLASS } from "@/lib/gate-health";
import type { UsageSnapshot } from "@/types";

const RED_CLASS = "text-destructive";
const AMBER_CLASS = "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400";
const BLUE_CLASS = "bg-blue-500/10 text-blue-600 dark:text-blue-400";
const GREEN_CLASS =
  "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";

function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    ok: true,
    fetchedAt: 0,
    userId: null,
    plan: "Code Max",
    planSlug: null,
    requestsLimit: null,
    requestsHardCap: null,
    requestsWindowSeconds: null,
    concurrencySoftLimit: 4,
    concurrencyHardCap: 8,
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
    priorityLow: false,
    boxedUntil: null,
    boxedReason: null,
    unitsDemoted: false,
    demotedUntil: null,
    serviceMode: { current: "interactive", resetsAt: null },
    priorityBudget: [],
    ...overrides,
  };
}

describe("TIER_CLASS export", () => {
  it("exports all four tier classes", () => {
    expect(TIER_CLASS.red).toBe(RED_CLASS);
    expect(TIER_CLASS.amber).toBe(AMBER_CLASS);
    expect(TIER_CLASS.blue).toBe(BLUE_CLASS);
    expect(TIER_CLASS.green).toBe(GREEN_CLASS);
  });
});

describe("serviceModeTier — green (nominal)", () => {
  it("green when mode is 'interactive' and no penalties", () => {
    expect(serviceModeTier(snapshot())).toBe("green");
  });

  it("green when mode is 'normal' and no penalties", () => {
    expect(serviceModeTier(snapshot({ serviceMode: { current: "normal", resetsAt: null } }))).toBe(
      "green",
    );
  });
});

describe("serviceModeTier — red", () => {
  it("red when boxedUntil is set", () => {
    expect(serviceModeTier(snapshot({ boxedUntil: Date.now() + 3600000 }))).toBe("red");
  });

  it("red when unitsDemoted is true", () => {
    expect(
      serviceModeTier(snapshot({ unitsDemoted: true, demotedUntil: Date.now() + 3600000 })),
    ).toBe("red");
  });

  it("red takes precedence over amber (priorityLow)", () => {
    expect(
      serviceModeTier(
        snapshot({
          boxedUntil: Date.now() + 3600000,
          priorityLow: true,
        }),
      ),
    ).toBe("red");
  });
});

describe("serviceModeTier — amber", () => {
  it("amber when priorityLow is true (mode interactive)", () => {
    expect(serviceModeTier(snapshot({ priorityLow: true }))).toBe("amber");
  });

  it("amber when mode is a LOW_SERVICE_MODE ('low_interactivity')", () => {
    expect(
      serviceModeTier(
        snapshot({
          serviceMode: { current: "low_interactivity", resetsAt: null },
        }),
      ),
    ).toBe("amber");
  });

  it("amber when mode is a LOW_SERVICE_MODE ('low')", () => {
    expect(serviceModeTier(snapshot({ serviceMode: { current: "low", resetsAt: null } }))).toBe(
      "amber",
    );
  });

  it("amber when mode is a LOW_SERVICE_MODE ('degraded')", () => {
    expect(
      serviceModeTier(snapshot({ serviceMode: { current: "degraded", resetsAt: null } })),
    ).toBe("amber");
  });

  it("amber when mode starts with 'low_'", () => {
    expect(
      serviceModeTier(snapshot({ serviceMode: { current: "low_custom", resetsAt: null } })),
    ).toBe("amber");
  });
});

describe("serviceModeTier — blue", () => {
  it("blue when mode is non-normal, non-low (e.g. 'throttled')", () => {
    expect(
      serviceModeTier(snapshot({ serviceMode: { current: "throttled", resetsAt: null } })),
    ).toBe("blue");
  });

  it("blue when mode is non-normal, non-low (e.g. 'maintenance')", () => {
    expect(
      serviceModeTier(snapshot({ serviceMode: { current: "maintenance", resetsAt: null } })),
    ).toBe("blue");
  });
});

describe("serviceModeTier — edge cases", () => {
  it("green when mode is 'interactive' and priorityLow false (default)", () => {
    expect(serviceModeTier(snapshot())).toBe("green");
  });

  it("amber when mode is 'normal' but priorityLow true", () => {
    expect(
      serviceModeTier(
        snapshot({
          priorityLow: true,
          serviceMode: { current: "normal", resetsAt: null },
        }),
      ),
    ).toBe("amber");
  });

  it("does not treat 'interactive' as non-normal (stays green)", () => {
    expect(
      serviceModeTier(snapshot({ serviceMode: { current: "interactive", resetsAt: null } })),
    ).toBe("green");
  });
});
