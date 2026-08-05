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
    plan: "unknown",
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
  it("renders Tier 0..Tier 3 pills with their tier color classes", async () => {
    const cases: Array<[UsageSnapshot["walletTier"], string, string]> = [
      [0, "Tier 0", "bg-amber-100"],
      [1, "Tier 1", "bg-blue-100"],
      [2, "Tier 2", "bg-violet-100"],
      [3, "Tier 3", "bg-yellow-200"],
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

  it("renders an unknown tier as a neutral wallet pill, never T— or ?", async () => {
    render(<WalletTierBadge snapshot={snapshot({ walletTier: "unknown" })} />);
    await flushEffects();
    const badge = pill();
    expect(badge).toHaveTextContent("wallet");
    expect(badge).not.toHaveTextContent("T—");
    expect(badge).not.toHaveTextContent("?");
    expect(badge).toHaveClass("text-muted-foreground");
  });

  it("renders a neutral wallet pill with the no-usage tooltip when snapshot is null", async () => {
    const { container } = render(<WalletTierBadge snapshot={null} />);
    await flushEffects();
    const badge = screen.getByRole("status");
    expect(badge).toHaveTextContent("wallet");
    expect(badge).not.toHaveTextContent("T—");
    expect(badge).toHaveClass("text-muted-foreground");
    expect(badge).toHaveAttribute("aria-label", "No usage data available");
    expect(container).toHaveTextContent("No usage data available · Check API key configuration");
  });

  it("survives a divergent runtime walletTier outside the union — neutral wallet, no undefined", async () => {
    // A divergent snapshot can carry a runtime walletTier outside the union
    // (e.g. an unexpected server value). tierStyle must stay total.
    const divergent = snapshot() as unknown as UsageSnapshot;
    divergent.walletTier = 7 as unknown as UsageSnapshot["walletTier"];
    const { container, unmount } = render(<WalletTierBadge snapshot={divergent} />);
    await flushEffects();
    expect(pill()).toHaveTextContent("wallet");
    expect(pill()).not.toHaveTextContent("T—");
    expect(container).not.toHaveTextContent("undefined");
    unmount();
  });

  it("shows the raw request count line without weighted wording", async () => {
    const { container, unmount } = render(
      <WalletTierBadge
        snapshot={snapshot({ weightedRequestsInWindow: 10, requestsInWindow: 5 })}
      />,
    );
    await flushEffects();
    expect(container).toHaveTextContent(/Requests in window: 5/);
    expect(container).not.toHaveTextContent("weighted");
    unmount();
  });

  it("drives the 429 imminent burst state off requests-in-window near the hard-cap margin", async () => {
    // Mirror the authoritative gate (request-gate.ts): block when
    // requestsInWindow >= hardCap - margin. The upstream soft-limit remainder
    // (requestsRemaining) must NOT trip it.
    // 457/1000 (~46%) is nowhere near the hard cap -> not imminent.
    const sparse = render(
      <WalletTierBadge
        snapshot={snapshot({ requestsHardCap: 1000, requestsInWindow: 457, requestsRemaining: 43 })}
      />,
    );
    await flushEffects();
    expect(sparse.container).not.toHaveTextContent("(429 imminent)");
    sparse.unmount();

    // At hardCap - margin (gate blocks at requestsInWindow >= 950).
    const atMargin = render(
      <WalletTierBadge snapshot={snapshot({ requestsHardCap: 1000, requestsInWindow: 950 })} />,
    );
    await flushEffects();
    expect(atMargin.container).toHaveTextContent("(429 imminent)");
    atMargin.unmount();

    // One below the margin -> still tolerated by the gate.
    const below = render(
      <WalletTierBadge snapshot={snapshot({ requestsHardCap: 1000, requestsInWindow: 949 })} />,
    );
    await flushEffects();
    expect(below.container).not.toHaveTextContent("(429 imminent)");
    below.unmount();

    // No hard cap known and usage below the fallback ceiling -> not imminent.
    const nullish = render(
      <WalletTierBadge snapshot={snapshot({ requestsHardCap: null, requestsInWindow: 100 })} />,
    );
    await flushEffects();
    expect(nullish.container).not.toHaveTextContent("(429 imminent)");
    expect(nullish.container).not.toHaveTextContent("(burst)");
  });

  it("formats the headline and appends resets-in only when windowResetsAt is set", async () => {
    const withReset = render(
      <WalletTierBadge
        snapshot={{
          walletTier: 2,
          requestsInWindow: 5,
          requestsLimit: 500,
          requestsHardCap: 1000,
          windowResetsAt: Date.now() + 3_600_000,
        }}
      />,
    );
    await flushEffects();
    expect(withReset.container).toHaveTextContent(/Wallet Tier 2 · 5 \/ 1000 used/);
    expect(withReset.container).toHaveTextContent(/resets in/);
    withReset.unmount();

    const noReset = render(
      <WalletTierBadge snapshot={snapshot({ walletTier: 2, requestsInWindow: 5 })} />,
    );
    await flushEffects();
    expect(noReset.container).toHaveTextContent(/Wallet Tier 2 · 5 \/ 1000 used/);
    expect(noReset.container).not.toHaveTextContent(/resets in/);
    noReset.unmount();
  });

  it("never renders the literal 'undefined' in the headline for a non-numeric tier", async () => {
    const { container } = render(
      <WalletTierBadge snapshot={snapshot({ walletTier: "unknown" })} />,
    );
    await flushEffects();
    expect(container).toHaveTextContent("Wallet Tier unknown");
    expect(container).not.toHaveTextContent("undefined");
  });

  it("exposes the badge as a role=status live region with a known-tier aria-label", async () => {
    render(
      <WalletTierBadge
        snapshot={snapshot({ walletTier: 2, requestsHardCap: 1000, requestsInWindow: 620 })}
      />,
    );
    await flushEffects();
    const badge = screen.getByRole("status");
    expect(badge).toHaveAttribute("aria-label", "Wallet tier 2, 62 percent of request limit used");
  });

  it("uses a neutral aria-label for a non-numeric tier", async () => {
    render(
      <WalletTierBadge
        snapshot={snapshot({
          walletTier: "unknown",
          requestsHardCap: 1000,
          requestsInWindow: 620,
        })}
      />,
    );
    await flushEffects();
    const badge = screen.getByRole("status");
    expect(badge).toHaveAttribute("aria-label", "Wallet tier, 62 percent of request limit used");
  });

  it("renders an accessible utilization progressbar with aria-valuenow", async () => {
    render(
      <WalletTierBadge snapshot={snapshot({ requestsHardCap: 1000, requestsInWindow: 620 })} />,
    );
    await flushEffects();
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuemin", "0");
    expect(bar).toHaveAttribute("aria-valuemax", "100");
    // requestsInWindow 620 / hardCap 1000 = 62%
    expect(bar).toHaveAttribute("aria-valuenow", "62");
  });

  it("always shows the rate-ceiling, shared-wallet, and concurrency lines", async () => {
    const { container } = render(<WalletTierBadge snapshot={snapshot({ walletTier: 3 })} />);
    await flushEffects();
    expect(container).toHaveTextContent("Rate ceiling for this wallet — limits, not spend balance");
    expect(container).toHaveTextContent("Limit shared across all keys/apps on this wallet");
    expect(container).toHaveTextContent(/Concurrency in-flight now: 1/);
    expect(container).toHaveTextContent(/Concurrency soft limit \(tolerated\): 8/);
    expect(container).toHaveTextContent(/Concurrency hard ceiling: 16/);
  });

  it("contains none of the deprecated plan names, unlimited text, or flash notation", async () => {
    const { container } = render(
      <WalletTierBadge
        snapshot={snapshot({
          walletTier: 2,
          weightedRequestsInWindow: 10,
          requestsInWindow: 5,
          requestsRemaining: 180,
          requestsHardCap: 1000,
          windowResetsAt: Date.now() + 3_600_000,
        })}
      />,
    );
    await flushEffects();
    for (const forbidden of [
      "Code Pro",
      "Code Max",
      "unlimited",
      "Wallet tier unavailable",
      "T—",
      "flash",
    ]) {
      expect(container).not.toHaveTextContent(forbidden);
    }
  });
});
