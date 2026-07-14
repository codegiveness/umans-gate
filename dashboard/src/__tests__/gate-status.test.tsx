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
};

describe("GateStatus service mode", () => {
  it("renders the current service mode badge", async () => {
    const { container } = render(
      <GateStatus
        stats={{ ...baseStats, serviceMode: { current: "interactive", resetsAt: null } }}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("interactive");
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
    expect(container).toHaveTextContent("Service mode: degraded");
    expect(container).toHaveTextContent("resets at");
  });

  it("renders normal service mode badge by default", async () => {
    const { container } = render(<GateStatus stats={baseStats} />);
    await flushEffects();
    expect(container).toHaveTextContent("normal");
  });
});
