import { statusClass } from "@/lib/format";
import { Badge } from "./ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const variantByClass: Record<
  ReturnType<typeof statusClass>,
  "default" | "secondary" | "outline" | "destructive"
> = {
  ok: "default",
  info: "secondary",
  warn: "outline",
  err: "destructive",
  "": "secondary",
};

const STATUS_TIP: Record<string, string> = {
  ok: "2xx/3xx success",
  info: "3xx redirection",
  warn: "4xx client error",
  err: "5xx server error",
  "": "No response yet",
};

interface StatusBadgeProps {
  status: number | null;
  size?: "default" | "sm";
}

export function StatusBadge({ status, size = "default" }: StatusBadgeProps) {
  const klass = statusClass(status);
  const variant = variantByClass[klass];
  const tip = STATUS_TIP[klass];
  const label = status == null ? "—" : String(status);

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>
        <Badge variant={variant} size={size}>
          {label}
        </Badge>
      </TooltipTrigger>
      <TooltipContent side="top">
        HTTP {label} — {tip}
      </TooltipContent>
    </Tooltip>
  );
}
