import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GateStatus } from "@/components/gate-status";
import { flushEffects } from "@/test/utils";
import type { GateStats } from "@/types";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const baseStats: GateStats = {
  usageOk: true,
  lastUsageFetch: null,
  active: 1,
  hardCap: 8,
  softLimit: 4,
  queued: 0,
  tier: "Code Max",
  breaker: "closed",
  priorityLow: false,
  boxed: false,
  boxedUntil: null,
  boxedReason: null,
  unitsDemoted: false,
  demotedUntil: null,
  requestsLimit: null,
  requestsInWindow: 0,
  requestsRemaining: null,
  windowSeconds: null,
  activeByIntention: {},
  queuedByIntention: {},
  reservations: {},
  serviceMode: { current: "normal", resetsAt: null },
  tokensIn: 0,
  tokensOut: 0,
  tokensCached: 0,
  windowStartedAt: null,
  windowResetsAt: null,
  windowRemainingMinutes: null,
};

describe("GateStatus service mode", () => {
  it("renders high priority badge when normal", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    expect(container).toHaveTextContent("high");
  });

  it("renders low badge when service mode is low_interactivity", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "low_interactivity", resetsAt: null },
        }}
      />,
    );
    await flushEffects();
    const badges = container.querySelectorAll("[class*='badge'], [data-slot='badge']");
    const badgeTexts = Array.from(badges).map((b) => b.textContent?.trim() ?? "");
    expect(badgeTexts).toContain("low");
    expect(badgeTexts).not.toContain("low_interactivity");
  });

  it("shows tooltip with service mode details", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          serviceMode: { current: "degraded", resetsAt: 1893456000000 },
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("service mode: degraded");
    expect(container).toHaveTextContent("resets at");
  });

  it("renders demoted badge when units demoted", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          unitsDemoted: true,
          demotedUntil: 1893456000000,
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("demoted");
  });

  it("renders only one status badge, not separate priority + service mode", async () => {
    const { container } = render(
      <GateStatus
        stats={{
          ...baseStats,
          priorityLow: false,
          serviceMode: { current: "low_interactivity", resetsAt: null },
        }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("low");
    expect(container).not.toHaveTextContent("high");
  });
});
