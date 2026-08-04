import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { badgeGold, badgeInfo, badgeViolet, badgeWarning } from "@/lib/badge-colors";
import { fmtDurationUntil } from "@/lib/format";
import type { UsageSnapshot, WalletTier } from "@/types";

type BurstStatus = "normal" | "burst" | "hard_burst";

const BURST_LABEL: Record<Exclude<BurstStatus, "normal">, string> = {
  burst: "burst",
  hard_burst: "429 imminent",
};

function burstStatus(primaryPct: number): BurstStatus {
  if (primaryPct >= 100) return "hard_burst";
  if (primaryPct >= 50) return "burst";
  return "normal";
}

function tierStyle(tier: WalletTier | undefined | null): {
  label: string;
  variant: "secondary" | "outline";
  className?: string;
} {
  switch (tier) {
    case 0:
      return { label: "T0", variant: "secondary", className: badgeWarning };
    case 1:
      return { label: "T1", variant: "secondary", className: badgeInfo };
    case 2:
      return { label: "T2", variant: "secondary", className: badgeViolet };
    case 3:
      return { label: "T3", variant: "secondary", className: badgeGold };
    case "unlimited":
      return { label: "unlimited", variant: "secondary" };
    case "unknown":
    default:
      return { label: "T—", variant: "outline", className: "text-muted-foreground" };
  }
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
            {"T—"}
          </Badge>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p>No usage data available · Check API key configuration</p>
        </TooltipContent>
      </Tooltip>
    );
  }

  const { walletTier } = snapshot;
  const isUnknown =
    walletTier !== 0 &&
    walletTier !== 1 &&
    walletTier !== 2 &&
    walletTier !== 3 &&
    walletTier !== "unlimited";

  const rawPrimaryPct =
    snapshot.requestsHardCap != null && snapshot.requestsHardCap > 0
      ? Math.round(
          ((snapshot.requestsHardCap - (snapshot.requestsRemaining ?? 0)) /
            snapshot.requestsHardCap) *
            100,
        )
      : 0;
  const primaryPct = Math.min(100, Math.max(0, rawPrimaryPct));
  const status = burstStatus(primaryPct);
  const { label, variant, className } = tierStyle(walletTier);

  const resets =
    snapshot.windowResetsAt != null
      ? ` · resets in ${fmtDurationUntil(snapshot.windowResetsAt)}`
      : "";
  const headline = `Wallet Tier ${walletTier} · ${snapshot.weightedRequestsInWindow} / ${snapshot.requestsLimit} used${resets}`;

  const tierName = typeof walletTier === "number" ? `tier ${walletTier}` : walletTier;
  const ariaLabel = `Wallet ${tierName}, ${primaryPct} percent of request limit used`;

  const burstLabel = status === "normal" ? "" : BURST_LABEL[status];

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Badge variant={variant} className={className} role="status" aria-label={ariaLabel}>
          {burstLabel ? `${label} (${burstLabel})` : label}
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
          {snapshot.weightedRequestsInWindow !== snapshot.requestsInWindow && (
            <p className="text-background/60">
              weighted: {snapshot.weightedRequestsInWindow} (flash = 0.5)
            </p>
          )}
          {walletTier === "unlimited" && <p>No request limit (Code Max / unlimited plan)</p>}
          {isUnknown && <p>Wallet tier unavailable</p>}
          <p className="text-background/60">
            Concurrency {snapshot.concurrentSessions} / {snapshot.concurrencySoftLimit} /{" "}
            {snapshot.concurrencyHardCap} concurrent
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
