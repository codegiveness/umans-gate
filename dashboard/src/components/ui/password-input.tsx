import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/**
 * Password input with show/hide toggle.
 * Renders as a text input with a trailing icon button that toggles visibility.
 */
export function PasswordInput({ className, ...props }: React.ComponentProps<"input">) {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative flex items-center">
      <Input type={visible ? "text" : "password"} className={cn("pr-9", className)} {...props} />
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0.5 h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={() => setVisible((v) => !v)}
              aria-label={visible ? "Hide password" : "Show password"}
              tabIndex={-1}
            />
          }
        >
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </TooltipTrigger>
        <TooltipContent side="top">{visible ? "Hide password" : "Show password"}</TooltipContent>
      </Tooltip>
    </div>
  );
}
