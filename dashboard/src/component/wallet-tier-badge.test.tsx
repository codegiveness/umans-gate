import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";

import { WalletTierBadge } from "@/components/wallet-tier-badge";
import { flushEffects } from "@/test/utils";
import type { UsageSnapshot } from "@/types";

// Base UI tooltips portaled popups are lazy — jsdom cannot open them. Render
// children directly (same pattern as gate-status.test.tsx) so tooltip copy is
// assertable without interaction.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

/** Build a full UsageSnapshot with sane defaults; override per-test. */
function snapshot(overrides: Partial<UsageSnapshot> = {}): UsageSnapshot {
  return {
    ok: true,
    fetchedAt: 0,
    userId: "u1",
    plan: "Code Max",
    walletTier: 2,
    planSlug: null,
    requestsLimit: 500,
    requestsHardCap: 1000,
    requestsWindowSeconds: 18000,
    concurrencySoftLimit: 8,
    concurrencyHardCap: 16,
    requestsInWindow: 0,
    weightedRequestsInWindow: 0,
    requestsRemaining: null,
    weightedRemainingRequests: null,
    concurrentSessions: 1,
    weightedConcurrentSessions: 1,
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
    serviceMode: { current: "normal", resetsAt: null },
    priorityBudget: [],
    ...overrides,
  };
}

function pill() {
  return screen.getByRole("status");
}

describe("WalletTierBadge", () => {
  it("renders T0..T3 pills with their tier color classes", async () => {
    const cases: Array<[UsageSnapshot["walletTier"], string, string]> = [
      [0, "T0", "bg-amber-100"],
      [1, "T1", "bg-blue-100"],
      [2, "T2", "bg-violet-100"],
      [3, "T3", "bg-yellow-200"],
    ];
    for (const [tier, label, color] of cases) {
      const { unmount } = render(<WalletTierBadge snapshot={snapshot({ walletTier: tier })} />);
      await flushEffects();
      const badge = pill();
      expect(badge).toHaveTextContent(label);
      expect(badge).toHaveClass(color);
      unmount();
    }
  });

  it("renders unknown tier as an outline T— (em dash, never a question mark)", async () => {
    render(<WalletTierBadge snapshot={snapshot({ walletTier: "unknown" })} />);
    await flushEffects();
    const badge = pill();
    expect(badge).toHaveTextContent("T—");
    expect(badge).not.toHaveTextContent("?");
    expect(badge).toHaveClass("text-muted-foreground");
  });

  it("renders an unlimited snapshot as an unlimited pill, not T—", async () => {
    const { container } = render(
      <WalletTierBadge
        snapshot={snapshot({
          walletTier: "unlimited",
          requestsHardCap: 1000,
          requestsRemaining: 900,
        })}
      />,
    );
    await flushEffects();
    const badge = pill();
    expect(badge).toHaveTextContent("unlimited");
    expect(badge).not.toHaveTextContent("T—");
    expect(badge).not.toHaveTextContent("(burst)");
    expect(container).toHaveTextContent("No request limit (Code Max / unlimited plan)");
  });

  it("renders T— no-data badge with the no-usage tooltip when snapshot is null", async () => {
    const { container } = render(<WalletTierBadge snapshot={null} />);
    await flushEffects();
    const badge = screen.getByRole("status");
    expect(badge).toHaveTextContent("T—");
    expect(badge).toHaveClass("text-muted-foreground");
    expect(badge).toHaveAttribute("aria-label", "No usage data available");
    expect(container).toHaveTextContent("No usage data available · Check API key configuration");
  });

  it("formats the headline and appends resets-in only when windowResetsAt is set", async () => {
    // Present resets segment.
    const withReset = render(
      <WalletTierBadge
        snapshot={snapshot({
          walletTier: 2,
          weightedRequestsInWindow: 10,
          requestsInWindow: 5,
          requestsLimit: 500,
          windowResetsAt: Date.now() + 3_600_000,
        })}
      />,
    );
    await flushEffects();
    expect(withReset.container).toHaveTextContent(/Wallet Tier 2 · 10 \/ 500 used/);
    expect(withReset.container).toHaveTextContent(/resets in/);
    withReset.unmount();

    // Absent resets segment — no dangling "resets in ".
    const noReset = render(<WalletTierBadge snapshot={snapshot({ walletTier: 2 })} />);
    await flushEffects();
    expect(noReset.container).toHaveTextContent(/Wallet Tier 2 · 0 \/ 500 used/);
    expect(noReset.container).not.toHaveTextContent(/resets in/);
    noReset.unmount();
  });

  it("always shows the rate-ceiling and shared-wallet lines", async () => {
    const { container } = render(<WalletTierBadge snapshot={snapshot({ walletTier: 3 })} />);
    await flushEffects();
    expect(container).toHaveTextContent("Rate ceiling for this wallet — limits, not spend balance");
    expect(container).toHaveTextContent("Limit shared across all keys/apps on this wallet");
  });

  it("shows the weighted annotation only when weighted != raw", async () => {
    const { unmount } = render(
      <WalletTierBadge
        snapshot={snapshot({ weightedRequestsInWindow: 10, requestsInWindow: 5 })}
      />,
    );
    await flushEffects();
    expect(screen.getByText(/weighted: 10 \(flash = 0\.5\)/)).toBeInTheDocument();
    unmount();

    render(
      <WalletTierBadge snapshot={snapshot({ weightedRequestsInWindow: 8, requestsInWindow: 8 })} />,
    );
    await flushEffects();
    expect(screen.queryByText(/weighted:/i)).not.toBeInTheDocument();
  });

  it("renders an accessible utilization progressbar with aria-valuenow", async () => {
    render(
      <WalletTierBadge snapshot={snapshot({ requestsHardCap: 1000, requestsRemaining: 380 })} />,
    );
    await flushEffects();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    // (1000 - 380) / 1000 = 62%
    expect(bar).toHaveAttribute("aria-valuenow", "62");
  });

  it("maps burst status boundaries: 49 normal, 50 burst, 100 hard_burst", async () => {
    // 49% — normal, no burst label.
    const normal = render(
      <WalletTierBadge snapshot={snapshot({ requestsHardCap: 1000, requestsRemaining: 510 })} />,
    );
    await flushEffects();
    expect(normal.container).not.toHaveTextContent("(burst)");
    expect(normal.container).not.toHaveTextContent("(429 imminent)");
    normal.unmount();

    // 50% — burst.
    const burst = render(
      <WalletTierBadge snapshot={snapshot({ requestsHardCap: 1000, requestsRemaining: 500 })} />,
    );
    await flushEffects();
    expect(burst.container).toHaveTextContent("(burst)");
    expect(burst.container).not.toHaveTextContent("(429 imminent)");
    burst.unmount();

    // 100% — hard_burst, 429 imminent.
    const hard = render(
      <WalletTierBadge snapshot={snapshot({ requestsHardCap: 1000, requestsRemaining: 0 })} />,
    );
    await flushEffects();
    expect(hard.container).toHaveTextContent("(429 imminent)");
    expect(hard.container).not.toHaveTextContent("(burst)");
  });

  it("exposes the badge as a role=status live region with a descriptive aria-label", async () => {
    render(
      <WalletTierBadge
        snapshot={snapshot({ walletTier: 2, requestsHardCap: 1000, requestsRemaining: 380 })}
      />,
    );
    await flushEffects();
    const badge = screen.getByRole("status");
    expect(badge).toHaveAttribute("aria-label", "Wallet tier 2, 62 percent of request limit used");
  });

  it("renders a T0 pill for the tier-0 cap/window case", async () => {
    render(
      <WalletTierBadge
        snapshot={snapshot({
          walletTier: 0,
          requestsLimit: 500,
          requestsHardCap: 1000,
          requestsWindowSeconds: 18000,
        })}
      />,
    );
    await flushEffects();
    expect(pill()).toHaveTextContent("T0");
  });

  it("never crashes on an unrecognized walletTier — renders T— instead of destructuring undefined", async () => {
    // A divergent snapshot can carry a runtime walletTier outside the union
    // (e.g. undefined from an older producer). tierStyle must stay total.
    const divergent = snapshot() as unknown as UsageSnapshot;
    divergent.walletTier = 7 as unknown as UsageSnapshot["walletTier"];
    const { container, unmount } = render(<WalletTierBadge snapshot={divergent} />);
    await flushEffects();
    expect(pill()).toHaveTextContent("T—");
    expect(container).toHaveTextContent("Wallet tier unavailable");
    unmount();
  });
});
