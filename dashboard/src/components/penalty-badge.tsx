import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { fmtDurationUntil, fmtUtcDateTime } from "@/lib/format";
import { computeGateHealth, type GateHealthInput } from "@/lib/gate-health";

/**
 * Unified penalty badge. Renders the pill (label) plus a structured tooltip
 * with the full /v1/usage penalty surface — every priority budget category,
 * account-level priority state, and service mode. Nothing filtered or cut.
 *
 * Pass null to render nothing (no layout shift on fresh dashboards).
 */
export function PenaltyBadge({ input }: { input: GateHealthInput | null }) {
  if (input === null) return null;

  const result = computeGateHealth(input);
  // Exclude "interactive" from account-wide — serviceModeTier treats it as
  // green (same as "normal"), so the badge shouldn't claim account-wide
  // penalty for it.
  const accountWide =
    input.boxed ||
    input.unitsDemoted ||
    (input.serviceMode != null &&
      input.serviceMode.current !== "normal" &&
      input.serviceMode.current !== "interactive");

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Badge variant={result.variant} className={result.className}>
          {result.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom" className="max-w-[440px]">
        <div className="space-y-2">
          {/* Budget categories — every category, nothing filtered */}
          {input.budgets.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-background/50">
                Budget categories
              </p>
              {input.budgets.map((cat) => {
                const urgent = cat.overBudgetToday || cat.usedPct >= 80;
                return (
                  <div key={cat.category} className="space-y-0.5">
                    <p className={urgent ? "font-semibold text-amber-400" : ""}>
                      {cat.label} — {cat.usedPct}% used
                      {cat.overBudgetToday ? " · over budget" : ""}
                    </p>
                    <p className="text-background/60">
                      {cat.models.length > 0 ? cat.models.join(", ") : "Account-wide — all models"}
                    </p>
                    <p className="text-background/60">
                      {cat.mode === "interactive" ? "Normal service" : `Throttled: ${cat.mode}`}
                      {cat.resetsAt != null ? ` · resets in ${fmtDurationUntil(cat.resetsAt)}` : ""}
                    </p>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-background/60">No budget categories configured</p>
          )}

          {/* Account-level priority + service mode */}
          <div className="space-y-1 border-t border-background/15 pt-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-background/50">
              Account state
            </p>
            <p className="text-background/70">
              Priority: {input.priorityLow ? "low (reduced throughput)" : "normal"}
              {input.boxed ? " · rate-limited" : ""}
              {input.unitsDemoted ? " · compute units demoted" : ""}
            </p>
            {input.boxedReason && <p className="text-background/60">Reason: {input.boxedReason}</p>}
            {input.boxedUntil != null && (
              <p className="text-background/60">boxed_until {fmtUtcDateTime(input.boxedUntil)}</p>
            )}
            {input.demotedUntil != null && (
              <p className="text-background/60">
                demoted_until {fmtUtcDateTime(input.demotedUntil)}
              </p>
            )}
            {input.serviceMode != null && (
              <p className="text-background/70">
                service_mode:{" "}
                {input.serviceMode.current === "interactive" ||
                input.serviceMode.current === "normal"
                  ? "normal"
                  : input.serviceMode.current}
                {input.serviceMode.resetsAt != null
                  ? ` · resets_at ${fmtUtcDateTime(input.serviceMode.resetsAt)}`
                  : ""}
              </p>
            )}
          </div>

          {accountWide && (
            <p className="text-background/60">⚠ Affects all models on this account</p>
          )}
          {result.tier === "green" && result.offendingCategories.length === 0 && (
            <p className="font-medium text-emerald-400">
              ✓ All categories healthy — no throttling active
            </p>
          )}
        </div>
      </TooltipContent>
    </Tooltip>
  );
}
