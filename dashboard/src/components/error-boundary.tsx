import React from "react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface ErrorBoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render(): React.ReactNode {
    const { error } = this.state;
    if (!error) {
      return this.props.children;
    }

    return (
      this.props.fallback ?? (
        <div className="flex flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
          <p className="text-sm font-medium text-destructive">Something went wrong</p>
          <p className="text-xs">{error.message}</p>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="outline" size="sm" onClick={() => window.location.reload()} />
              }
            >
              Reload
            </TooltipTrigger>
            <TooltipContent side="top">Reload the page</TooltipContent>
          </Tooltip>
        </div>
      )
    );
  }
}
