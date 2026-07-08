import { useMemo } from "react";

import { syntaxHighlight } from "@/lib/format";

interface JsonViewerProps {
  body: string | null | undefined;
}

export function JsonViewer({ body }: JsonViewerProps) {
  const formatted = useMemo(() => {
    if (!body) return "";
    try {
      const parsed = JSON.parse(body) as unknown;
      return JSON.stringify(parsed, null, 2);
    } catch {
      return body;
    }
  }, [body]);

  if (!body) {
    return <div className="text-muted-foreground italic">empty body</div>;
  }

  return (
    <pre
      className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: syntaxHighlight(formatted) }}
    />
  );
}
