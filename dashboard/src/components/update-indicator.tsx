import { ArrowUpCircle } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useVersion } from "@/hooks/use-version";

interface UpdateIndicatorProps {
  onNavigateToConfig: () => void;
}

export function UpdateIndicator({ onNavigateToConfig }: UpdateIndicatorProps) {
  const { version } = useVersion();

  if (!version?.updateAvailable || !version.latest) {
    return null;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8"
          onClick={onNavigateToConfig}
          aria-label={`Update available: v${version.current} to v${version.latest}`}
        >
          <ArrowUpCircle className="h-4 w-4 text-amber-500" aria-hidden="true" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        v{version.current} → v{version.latest} available
      </TooltipContent>
    </Tooltip>
  );
}
