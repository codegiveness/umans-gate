import { FileText } from "lucide-react";
import { lazy } from "react";

import { Spinner } from "@/components/ui/spinner";
import type { CaptureState } from "@/types";

const JsonViewer = lazy(() =>
  import("@/components/json-viewer").then((m) => ({ default: m.JsonViewer })),
);
const SseViewer = lazy(() =>
  import("@/components/sse-viewer").then((m) => ({ default: m.SseViewer })),
);

const IN_FLIGHT_STATES: ReadonlyArray<CaptureState> = ["enqueued", "streaming", "cooling_down"];

export function BodyRenderer({
  body,
  isSse,
  state,
}: {
  body: string | null | undefined;
  isSse: boolean;
  state?: CaptureState;
}) {
  if (body === null) {
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
        Response body not captured
      </div>
    );
  }

  if (!body) {
    return (
      <div className="flex items-center gap-1.5 text-muted-foreground italic">
        <FileText className="h-3.5 w-3.5" />
        empty body
      </div>
    );
  }

  if (body.startsWith("__B64__")) {
    return (
      <div className="text-muted-foreground italic">
        binary data (base64, {body.length - 6} chars)
      </div>
    );
  }

  if (isSse) {
    return <SseViewer body={body} />;
  }

  try {
    JSON.parse(body);
    return <JsonViewer body={body} />;
  } catch {
    return (
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {body}
      </pre>
    );
  }
}
