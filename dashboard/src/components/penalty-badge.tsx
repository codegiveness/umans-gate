import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtDurationUntil, fmtUtcDateTime } from "@/lib/format";
import { computeGateHealth, type GateHealthInput } from "@/lib/gate-health";

/**
 * Unified penalty badge. Renders the pill (label) plus a structured tooltip
 * listing all offending budget categories and account-level penalties.
 *
 * Pass null to render nothing (no layout shift on fresh dashboards).
 */
export function PenaltyBadge({ input }: { input: GateHealthInput | null }) {
  if (input === null) return null;

  const result = computeGateHealth(input);
  const accountWide =
    input.boxed ||
    input.unitsDemoted ||
    (input.serviceMode != null && input.serviceMode.current !== "normal");

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Badge variant={result.variant} className={result.className}>
          {result.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[320px]">
        <div className="space-y-1">
          {result.admissionDetail && input.serviceMode == null && <p>{result.admissionDetail}</p>}
          {result.offendingCategories.length > 0 && (
            <div className="space-y-1">
              {result.offendingCategories.map((cat) => (
                <div key={cat.label} className="space-y-0.5">
                  <p>
                    {cat.label} {cat.usedPct}%
                  </p>
                  <p className="text-background/70">
                    {cat.models.length > 0 ? cat.models.join(", ") : "Account-wide — all models"}
                  </p>
                  <p className="text-background/70">mode: {cat.mode}</p>
                  {cat.overBudgetToday && <p className="text-background/70">over budget today</p>}
                  {cat.resetsAt !== null && (
                    <p className="text-background/70">resets in {fmtDurationUntil(cat.resetsAt)}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          {input.boxedReason && input.serviceMode == null && <p>reason: {input.boxedReason}</p>}
          {input.boxed && input.boxedUntil !== null && input.serviceMode == null && (
            <p className="text-background/70">boxed until {fmtUtcDateTime(input.boxedUntil)}</p>
          )}
          {input.unitsDemoted && input.demotedUntil !== null && input.serviceMode == null && (
            <p className="text-background/70">demoted until {fmtUtcDateTime(input.demotedUntil)}</p>
          )}
          {accountWide && <p className="text-background/70">Account-wide — all models</p>}
          {result.tier === "green" && result.offendingCategories.length === 0 && (
            <p className="text-background/70">All systems nominal</p>
          )}
          {input.serviceMode != null && (
            <div className="space-y-0.5 border-t border-background/10 pt-1">
              <p className="text-background/70">
                service_mode: {input.serviceMode.current}
                {input.serviceMode.resetsAt !== null && (
                  <span> · resets_at {fmtUtcDateTime(input.serviceMode.resetsAt)}</span>
                )}
              </p>
              <p className="text-background/70">
                priority: {input.priorityLow ? "low" : "normal"}
                {input.boxed ? " · boxed" : ""}
                {input.unitsDemoted ? " · units_demoted" : ""}
                {input.boxedReason ? ` · reason: ${input.boxedReason}` : ""}
                {input.boxedUntil !== null && (
                  <span> · boxed_until {fmtUtcDateTime(input.boxedUntil)}</span>
                )}
                {input.demotedUntil !== null && (
                  <span> · demoted_until {fmtUtcDateTime(input.demotedUntil)}</span>
                )}
              </p>
            </div>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
