import { LoaderCircle } from "lucide-react";
import type * as React from "react";

import { cn } from "@/lib/utils";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <LoaderCircle
      role="img"
      aria-label="Loading"
      className={cn("animate-spin size-4", className)}
      {...props}
    />
  );
}

export { Spinner };
