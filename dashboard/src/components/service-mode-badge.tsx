import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtDurationUntil, fmtUtcDateTime } from "@/lib/format";
import { serviceModeTier, TIER_CLASS } from "@/lib/gate-health";
import type { UsageSnapshot } from "@/types";

/**
 * Always-on badge showing the current upstream service mode. Renders null
 * when snapshot is null or fetch failed (no layout shift). Color follows
 * the same tier scheme as PenaltyBadge (red > amber > blue > green).
 *
 * Tooltip lists service mode, priority status, and priority budget
 * categories — the three usage fields not surfaced by PenaltyBadge when
 * everything is nominal.
 */
export function ServiceModeBadge({ snapshot }: { snapshot: UsageSnapshot | null }) {
  if (snapshot === null || !snapshot.ok) return null;

  const tier = serviceModeTier(snapshot);
  const mode = snapshot.serviceMode.current;
  const { priorityBudget } = snapshot;

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Badge variant={tier === "red" ? "destructive" : "secondary"} className={TIER_CLASS[tier]}>
          {mode}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[320px]">
        <div className="space-y-1">
          <p>
            service mode: <span className="font-mono">{mode}</span>
            {snapshot.serviceMode.resetsAt !== null && (
              <span className="text-background/70">
                {" "}
                · resets {fmtDurationUntil(snapshot.serviceMode.resetsAt)}
              </span>
            )}
          </p>
          <p className="text-background/70">
            priority:{" "}
            {snapshot.boxedUntil !== null
              ? "boxed"
              : snapshot.unitsDemoted
                ? "demoted"
                : snapshot.priorityLow
                  ? "low"
                  : "normal"}
            {snapshot.boxedReason && <span> · {snapshot.boxedReason}</span>}
          </p>
          {snapshot.boxedUntil !== null && (
            <p className="text-background/70">boxed until {fmtUtcDateTime(snapshot.boxedUntil)}</p>
          )}
          {snapshot.demotedUntil !== null && (
            <p className="text-background/70">
              demoted until {fmtUtcDateTime(snapshot.demotedUntil)}
            </p>
          )}
          {priorityBudget.length > 0 && (
            <div className="space-y-1 border-t border-background/10 pt-1">
              {priorityBudget.map((cat) => (
                <div key={cat.category} className="space-y-0.5">
                  <p>
                    {cat.label} <span className="font-mono">{cat.usedPct}%</span>
                    <span className="text-background/70"> · {cat.mode}</span>
                    {cat.overBudgetToday && (
                      <span className="text-background/70"> · over budget</span>
                    )}
                  </p>
                  {cat.models.length > 0 && (
                    <p className="text-background/70 break-all">{cat.models.join(", ")}</p>
                  )}
                  {cat.resetsAt !== null && (
                    <p className="text-background/70">resets in {fmtDurationUntil(cat.resetsAt)}</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
