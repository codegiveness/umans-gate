import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface WsStatusBadgeProps {
  wsState: "live" | "down" | "unavailable";
}

const CONFIG = {
  live: {
    label: "Live",
    variant: "secondary" as const,
    dotClass: "bg-primary",
    pulse: false,
    tip: "Real-time updates active",
  },
  down: {
    label: "Reconnecting",
    variant: "outline" as const,
    dotClass: "bg-muted-foreground",
    pulse: true,
    tip: "Connection lost — auto-retrying",
  },
  unavailable: {
    label: "Disconnected",
    variant: "destructive" as const,
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
            aria-label={`WebSocket: ${config.label}`}
          />
        }
      >
        <Badge variant={config.variant} size="sm" className="gap-1">
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
