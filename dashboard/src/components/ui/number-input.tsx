import { Minus, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface NumberInputProps extends Omit<React.ComponentProps<"input">, "onChange"> {
  min?: number;
  max?: number;
  suffix?: string;
  onChange?: (value: string) => void;
}

/**
 * Number input with hidden native spinner and custom +/- stepper buttons.
 * The native spinner is hidden via CSS (see index.css `.no-spinner`).
 * The stepper buttons clamp to min/max when provided.
 */
export function NumberInput({
  className,
  min,
  max,
  suffix,
  onChange,
  value,
  disabled,
  ...props
}: NumberInputProps) {
  const numVal = typeof value === "string" || typeof value === "number" ? value : "";

  function step(delta: number) {
    if (disabled) return;
    const current = typeof numVal === "string" ? Number(numVal) : numVal;
    if (Number.isNaN(current)) return;
    let next = current + delta;
    if (min !== undefined && next < min) next = min;
    if (max !== undefined && next > max) next = max;
    onChange?.(String(next));
  }

  return (
    <div className="flex items-stretch">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 rounded-r-none border-r-0 text-muted-foreground hover:text-foreground"
              onClick={() => step(-1)}
              disabled={
                disabled || (min !== undefined && typeof numVal === "number" && numVal <= min)
              }
              aria-label="Decrease"
              tabIndex={-1}
            />
          }
        >
          <Minus className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent side="top">Decrease value</TooltipContent>
      </Tooltip>
      <div className="relative flex-1">
        <Input
          type="number"
          inputMode="numeric"
          className={cn("no-spinner rounded-none text-center", suffix && "pr-9", className)}
          value={value}
          onChange={(e) => onChange?.(e.target.value)}
          disabled={disabled}
          {...props}
        />
        {suffix ? (
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
            {suffix}
          </span>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="h-8 w-8 rounded-l-none border-l-0 text-muted-foreground hover:text-foreground"
              onClick={() => step(1)}
              disabled={
                disabled || (max !== undefined && typeof numVal === "number" && numVal >= max)
              }
              aria-label="Increase"
              tabIndex={-1}
            />
          }
        >
          <Plus className="h-3.5 w-3.5" />
        </TooltipTrigger>
        <TooltipContent side="top">Increase value</TooltipContent>
      </Tooltip>
    </div>
  );
}
