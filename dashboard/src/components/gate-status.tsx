import { AlertTriangle, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { PenaltyBadge } from "@/components/penalty-badge";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { badgeGold, badgeInfo, badgeWarning } from "@/lib/badge-colors";
import { mergePenaltyInput } from "@/lib/gate-health";
import { cn } from "@/lib/utils";
import type { GateStats, UsageSnapshot } from "@/types";

const tierBadgeClass: Record<GateStats["tier"], string | undefined> = {
  "Code Max": badgeGold,
  "Code Pro": badgeInfo,
  unknown: undefined,
};

const BREAKER_DESC: Record<string, string> = {
  closed: "Upstream healthy — requests flow normally",
  open: "Too many 429s — requests fail fast until cooldown",
  half_open: "Probe request sent to test upstream recovery",
};

const breakerIconClass: Record<string, string> = {
  open: "text-destructive",
  half_open: "text-muted-foreground",
  closed: "text-primary",
};

const BreakerIcon: Record<string, typeof ShieldCheck> = {
  open: ShieldAlert,
  half_open: ShieldQuestion,
  closed: ShieldCheck,
};

export function GateStatus({
  stats,
  usageSnapshot = null,
}: {
  stats: GateStats | null;
  usageSnapshot?: UsageSnapshot | null;
}) {
  if (!stats) return null;

  const pct = stats.effectiveLimit > 0 ? (stats.active / stats.effectiveLimit) * 100 : 0;
  const tierLabel = stats.tier === "unknown" ? "no key" : stats.tier;

  return (
    <div className="border-b border-border px-4 py-2 text-xs">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap flex-1">
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Badge variant="secondary" className={tierBadgeClass[stats.tier]}>
                {tierLabel}
              </Badge>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[240px]">
              {stats.tier === "Code Max"
                ? "Highest concurrency — no rate limit gating"
                : stats.tier === "Code Pro"
                  ? "Standard concurrency with rate-limit gating"
                  : "No API key configured — upstream defaults apply"}
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<span className="cursor-help" />}>
              <span className={cn("font-mono", stats.breaker === "open" && "text-destructive")}>
                {stats.active}/{stats.effectiveLimit}
              </span>
              <span className="text-muted-foreground ml-1">cap</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {stats.active} active · {stats.effectiveLimit} effective · {stats.hardCap} hard cap ·{" "}
              {stats.softLimit} soft limit
            </TooltipContent>
          </Tooltip>
          {stats.queued > 0 && (
            <>
              <span className="font-mono text-muted-foreground">{stats.queued}</span>
              <span className="text-muted-foreground">queued</span>
            </>
          )}
          <span className="text-muted-foreground">·</span>
          <Tooltip>
            <TooltipTrigger
              render={<span className="inline-flex items-center gap-1 cursor-help" />}
            >
              {(() => {
                const Icon = BreakerIcon[stats.breaker] ?? ShieldQuestion;
                return (
                  <Icon
                    aria-hidden
                    className={cn(
                      "h-3.5 w-3.5",
                      breakerIconClass[stats.breaker] ?? "text-muted-foreground",
                    )}
                  />
                );
              })()}
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px]">
              {BREAKER_DESC[stats.breaker] ?? stats.breaker}
            </TooltipContent>
          </Tooltip>
          {stats.watchdog_disabled && (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="secondary" className={badgeWarning}>
                  <AlertTriangle aria-hidden className="h-3 w-3" />
                  watchdog off
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[280px]">
                TTFT watchdog auto-disabled after {stats.watchdog_consecutive_failures} consecutive
                retry failures. Upstream stalls will no longer be retried.
              </TooltipContent>
            </Tooltip>
          )}
          {!stats.usageOk && (
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Badge variant="secondary" className={badgeWarning}>
                  usage: stale
                </Badge>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="max-w-[240px]">
                Last usage fetch failed — rate limit counters may be inaccurate
              </TooltipContent>
            </Tooltip>
          )}
          <PenaltyBadge input={mergePenaltyInput(stats, usageSnapshot)} />
        </div>
      </div>

      <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-secondary">
        <div
          className={cn("h-full transition-all", pct >= 100 ? "bg-destructive" : "bg-primary")}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>

      {stats.requestsLimit !== null && (
        <div className="mt-1 flex items-center gap-2 text-muted-foreground">
          <span>
            requests: {stats.requestsInWindow}
            {stats.requestsLimit ? ` / ${stats.requestsLimit}` : ""}
          </span>
          {stats.requestsRemaining !== null && <span>({stats.requestsRemaining} remaining)</span>}
          {stats.windowSeconds && <span>· {Math.round(stats.windowSeconds / 3600)}h window</span>}
        </div>
      )}
    </div>
  );
}
