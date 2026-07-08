import { ChevronDown } from "lucide-react";

import { syntaxHighlight } from "@/lib/format";

interface SseEvent {
  id: number;
  name: string;
  data: string;
  preview: string;
}

function parseSSE(body: string): SseEvent[] {
  const events = body.split(/\r?\n\r?\n/).filter((e) => e.trim());
  return events.map((ev, i) => {
    const dataLines = ev
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.replace(/^data:\s?/, ""));
    const data = dataLines.join("\n");
    const nameMatch = ev.match(/^event:\s?(.*)$/m);
    const name = nameMatch?.[1] ?? "";

    let preview = "";
    try {
      const parsed = JSON.parse(data) as unknown;
      preview = extractDelta(parsed) ?? "";
    } catch {
      preview = data.slice(0, 60);
    }

    return {
      id: i,
      name,
      data,
      preview,
    };
  });
}

function extractDelta(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;

  const obj = value as Record<string, unknown>;
  const choices = (obj.choices ?? obj.delta) as unknown;

  if (Array.isArray(choices)) {
    const first = choices[0] as Record<string, unknown> | undefined;
    const d = (first?.delta as Record<string, unknown>)?.content ?? first?.text;
    if (d != null) return JSON.stringify(d);
  }

  const delta = obj.delta as Record<string, unknown> | undefined;
  if (delta?.text != null) return JSON.stringify(delta.text);
  if (obj.type != null) return String(obj.type);

  return undefined;
}

interface SseViewerProps {
  body: string | null | undefined;
}

export function SseViewer({ body }: SseViewerProps) {
  if (!body) {
    return <div className="text-muted-foreground italic">empty body</div>;
  }

  const events = parseSSE(body);

  return (
    <div>
      <div className="mb-2.5 text-xs text-muted-foreground">
        {events.length} event{events.length === 1 ? "" : "s"} · expand each to inspect payload
      </div>
      {events.map((ev) => {
        const label = ev.name ? `event: ${ev.name}` : `#${ev.id + 1}`;
        return (
          <details
            key={ev.id}
            className="group mb-1.5 overflow-hidden rounded-md border border-border bg-card"
          >
            <summary className="flex cursor-pointer items-center gap-1 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground select-none hover:text-foreground">
              <ChevronDown className="h-3 w-3 transition-transform group-open:rotate-180" />
              <span>{label}</span>
              {ev.preview && <span className="ml-1 truncate">{ev.preview}</span>}
            </summary>
            <div className="border-t border-border px-2.5 py-2">
              <EventData data={ev.data} />
            </div>
          </details>
        );
      })}
    </div>
  );
}

function EventData({ data }: { data: string }) {
  try {
    const parsed = JSON.parse(data) as unknown;
    const formatted = JSON.stringify(parsed, null, 2);
    return (
      <pre
        className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed"
        // eslint-disable-next-line react/no-danger
        dangerouslySetInnerHTML={{ __html: syntaxHighlight(formatted) }}
      />
    );
  } catch {
    return (
      <pre className="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
        {data}
      </pre>
    );
  }
}
