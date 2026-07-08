import { safeParseHeaders } from "@/lib/format";

interface HeadersViewerProps {
  headers: string | null | undefined;
}

export function HeadersViewer({ headers }: HeadersViewerProps) {
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
