import { FileText, TriangleAlert } from "lucide-react";
import { lazy } from "react";

const JsonViewer = lazy(() =>
  import("@/components/json-viewer").then((m) => ({ default: m.JsonViewer })),
);
const SseViewer = lazy(() =>
  import("@/components/sse-viewer").then((m) => ({ default: m.SseViewer })),
);

export function BodyRenderer({ body, isSse }: { body: string | null | undefined; isSse: boolean }) {
  if (body === null) {
    return (
      <div className="flex items-center gap-1.5 text-destructive italic">
        <TriangleAlert className="h-3.5 w-3.5" />
        body corrupted or unavailable
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
