import { Moon, Sun } from "lucide-react";

import { useTheme } from "./theme-provider";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

/**
 * Non-interactive theme indicator. Displays an icon based on the resolved
 * theme (light → Sun, dark → Moon) and follows the system preference.
 * Not clickable — no hover state, no dropdown.
 */
export function ModeToggle() {
  const { resolvedTheme } = useTheme();

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className="inline-flex size-8 items-center justify-center text-muted-foreground"
            aria-label={`Theme: ${resolvedTheme}`}
          />
        }
      >
        {resolvedTheme === "dark" ? (
          <Moon className="h-[1.2rem] w-[1.2rem]" aria-hidden="true" />
        ) : (
          <Sun className="h-[1.2rem] w-[1.2rem]" aria-hidden="true" />
        )}
      </TooltipTrigger>
      <TooltipContent side="bottom">Follows system theme</TooltipContent>
    </Tooltip>
  );
}
