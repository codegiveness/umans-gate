import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { badgeGold, badgeInfo, badgeViolet, badgeWarning } from "@/lib/badge-colors";
import { fmtDurationUntil } from "@/lib/format";
import type { UsageSnapshot, WalletTier } from "@/types";

const NEUTRAL_LABEL = "wallet";

function tierStyle(tier: WalletTier | undefined | null): {
  label: string;
  variant: "secondary" | "outline";
  className?: string;
} {
  switch (tier) {
    case 0:
      return { label: "Tier 0", variant: "secondary", className: badgeWarning };
    case 1:
      return { label: "Tier 1", variant: "secondary", className: badgeInfo };
    case 2:
      return { label: "Tier 2", variant: "secondary", className: badgeViolet };
    case 3:
      return { label: "Tier 3", variant: "secondary", className: badgeGold };
    default:
      return { label: NEUTRAL_LABEL, variant: "outline", className: "text-muted-foreground" };
  }
}

const REQUEST_MARGIN = 50;

function imminentLabel(requestsInWindow: number, ceiling: number | null): string | null {
  // Mirror the authoritative request gate (request-gate.ts): 429 looms when the
  // unweighted requests-in-window crosses ceiling - margin. The upstream soft-limit
  // remainder (requestsRemaining) must NOT drive this.
  if (ceiling != null && requestsInWindow >= ceiling - REQUEST_MARGIN) return "429 imminent";
  return null;
}

/**
 * Compact wallet-tier pill badge wrapping a tooltip with live usage and an
 * authoritative utilization bar (raw-primary, server-derived).
 */
export function WalletTierBadge({ snapshot }: { snapshot: UsageSnapshot | null }) {
  if (snapshot === null) {
    return (
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Badge
            variant="outline"
            className="text-muted-foreground"
            role="status"
            aria-label="No usage data available"
          >
            {NEUTRAL_LABEL}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>No usage data available · Check API key configuration</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  const { walletTier } = snapshot;

  const ceiling = snapshot.requestsHardCap ?? snapshot.requestsLimit;
  const rawPrimaryPct =
    ceiling != null && ceiling > 0
      ? Math.round((snapshot.requestsInWindow / ceiling) * 100)
      : 0;
  const primaryPct = Math.min(100, Math.max(0, rawPrimaryPct));
  const { label, variant, className } = tierStyle(walletTier);
  const suffix = imminentLabel(snapshot.requestsInWindow, ceiling);

  const resets =
    snapshot.windowResetsAt != null
      ? ` · resets in ${fmtDurationUntil(snapshot.windowResetsAt)}`
      : "";
  const headlineTier = typeof walletTier === "number" ? walletTier : "unknown";
  const headline = `Wallet Tier ${headlineTier} · ${snapshot.requestsInWindow} / ${ceiling} used${resets}`;

  const ariaLabel =
    typeof walletTier === "number"
      ? `Wallet tier ${walletTier}, ${primaryPct} percent of request limit used`
      : `Wallet tier, ${primaryPct} percent of request limit used`;

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Badge variant={variant} className={className} role="status" aria-label={ariaLabel}>
          {suffix ? `${label} (${suffix})` : label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[440px]">
        <div className="space-y-1.5">
          <p className="text-xs font-semibold">{headline}</p>
          <div
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={primaryPct}
            className="h-1.5 w-full overflow-hidden rounded-full bg-background/25"
          >
            <div
              className="h-full rounded-full bg-background/70"
              style={{ width: `${primaryPct}%` }}
            />
          </div>
          <p className="text-background/70">
            Rate ceiling for this wallet — limits, not spend balance
          </p>
          <p className="text-background/70">Limit shared across all keys/apps on this wallet</p>
          <p className="text-background/60">Requests in window: {snapshot.requestsInWindow}</p>
          <p className="text-background/60">
            Concurrency in-flight now: {snapshot.concurrentSessions}
          </p>
          <p className="text-background/60">
            Concurrency soft limit (tolerated): {snapshot.concurrencySoftLimit}
          </p>
          <p className="text-background/60">
            Concurrency hard ceiling: {snapshot.concurrencyHardCap}
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
