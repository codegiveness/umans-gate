import { FileText } from "lucide-react";

import { Spinner } from "@/components/ui/spinner";
import { safeParseHeaders } from "@/lib/format";
import type { CaptureState } from "@/types";

const IN_FLIGHT_STATES: ReadonlyArray<CaptureState> = ["enqueued", "streaming", "cooling_down"];

interface HeadersViewerProps {
  headers: string | null | undefined;
  state?: CaptureState;
}

export function HeadersViewer({ headers, state }: HeadersViewerProps) {
  if (headers === null) {
    if (state && IN_FLIGHT_STATES.includes(state)) {
      return (
        <div className="flex items-center gap-1.5 text-muted-foreground italic">
          <Spinner className="h-3.5 w-3.5" />
          Response still streaming…
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground italic">
        <FileText className="h-3.5 w-3.5" />
        Headers not captured
      </div>
    );
  }

  const parsed = safeParseHeaders(headers);
  const keys = Object.keys(parsed);

  if (keys.length === 0) {
    return <div className="text-muted-foreground italic">no headers</div>;
  }

  return (
    <div className="grid grid-cols-[minmax(140px,max-content)_1fr] gap-x-3 gap-y-0.5">
      {keys.map((k) => (
        <div key={k} className="contents">
          <div className="font-mono text-xs text-primary">{k}</div>
          <div className="break-all font-mono text-xs">{parsed[k]}</div>
        </div>
      ))}
    </div>
  );
}
