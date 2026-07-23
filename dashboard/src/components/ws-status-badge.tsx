import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { badgeSuccess, badgeWarning, dotSuccess, dotWarning } from "@/lib/badge-colors";
import { cn } from "@/lib/utils";

interface WsStatusBadgeProps {
  wsState: "live" | "down" | "unavailable";
}

const CONFIG = {
  live: {
    label: "Live",
    variant: "secondary" as const,
    className: badgeSuccess,
    dotClass: dotSuccess,
    pulse: false,
    tip: "Real-time updates active",
  },
  down: {
    label: "Reconnecting",
    variant: "secondary" as const,
    className: badgeWarning,
    dotClass: dotWarning,
    pulse: true,
    tip: "Connection lost — auto-retrying",
  },
  unavailable: {
    label: "Disconnected",
    variant: "destructive" as const,
    className: undefined,
    dotClass: "bg-destructive",
    pulse: false,
    tip: "WebSocket unavailable — refresh page",
  },
} as const;

export function WsStatusBadge({ wsState }: WsStatusBadgeProps) {
  const config = CONFIG[wsState];

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex items-center outline-none focus-visible:ring-2 focus-visible:ring-ring rounded"
            role="img"
            aria-label={`WebSocket: ${config.label}`}
          />
        }
      >
        <Badge variant={config.variant} size="sm" className={cn("gap-1", config.className)}>
          <span
            aria-hidden
            className={cn(
              "inline-block h-1.5 w-1.5 rounded-full",
              config.dotClass,
              config.pulse && "animate-pulse",
            )}
          />
          {config.label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="bottom">{config.tip}</TooltipContent>
    </Tooltip>
  );
}
