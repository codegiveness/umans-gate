import { Monitor, Moon, Sun } from "lucide-react";

import { type Theme, useTheme } from "./theme-provider";
import { Button } from "./ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip";

const THEME_ORDER: Theme[] = ["system", "light", "dark"];

const THEME_LABELS: Record<Theme, string> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

export function ModeToggle() {
  const { theme, setTheme } = useTheme();

  const currentIndex = THEME_ORDER.indexOf(theme);
  const next = THEME_ORDER[(currentIndex + 1) % THEME_ORDER.length];

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTheme(next)}
          aria-label={`Theme: ${THEME_LABELS[theme]}`}
        >
          {theme === "dark" ? (
            <Moon className="h-[1.2rem] w-[1.2rem]" aria-hidden="true" />
          ) : theme === "light" ? (
            <Sun className="h-[1.2rem] w-[1.2rem]" aria-hidden="true" />
          ) : (
            <Monitor className="h-[1.2rem] w-[1.2rem]" aria-hidden="true" />
          )}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {THEME_LABELS[theme]} — click for {THEME_LABELS[next].toLowerCase()}
      </TooltipContent>
    </Tooltip>
  );
}
