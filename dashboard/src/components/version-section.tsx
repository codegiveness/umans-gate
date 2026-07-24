import { AlertCircle, Check, ChevronRight, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useVersion, type VersionInfo } from "@/hooks/use-version";

function formatRelativeTime(ts: number | null): string {
  if (ts === null) return "never";
  const diffMs = Date.now() - ts;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export function VersionSection() {
  const { version, loading, checking, checkNow } = useVersion();
  const [, forceTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30000);
    return () => clearInterval(id);
  }, []);

  if (loading && !version) {
    return (
      <Card>
        <CardContent className="py-4 text-xs text-muted-foreground">Checking version…</CardContent>
      </Card>
    );
  }

  if (!version) {
    return null;
  }

  if (version.error) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between py-4">
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-destructive" />
            <span className="text-xs text-destructive">Version check failed</span>
          </div>
          <Button size="sm" variant="outline" disabled={checking} onClick={() => void checkNow()}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
            {checking ? "Checking…" : "Retry"}
          </Button>
        </CardContent>
      </Card>
    );
  }

  return <VersionCard version={version} checking={checking} onCheck={checkNow} />;
}

function VersionCard({
  version,
  checking,
  onCheck,
}: {
  version: VersionInfo;
  checking: boolean;
  onCheck: () => void;
}) {
  const [notesExpanded, setNotesExpanded] = useState(false);
  const showNotes = version.updateAvailable && version.releaseNotes !== null;

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">v{version.current}</span>
          {version.updateAvailable ? (
            <Badge variant="outline" className="border-amber-500/40 text-amber-600">
              v{version.latest} available
            </Badge>
          ) : (
            <Badge variant="outline" className="border-emerald-500/40 text-emerald-600">
              <Check className="h-3 w-3" />
              Up to date
            </Badge>
          )}
          <span className="text-xs text-muted-foreground">
            Checked {formatRelativeTime(version.lastCheckedAt)}
          </span>
        </div>
        <Button size="sm" variant="ghost" disabled={checking} onClick={onCheck}>
          <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
          {checking ? "Checking…" : "Check now"}
        </Button>
      </CardContent>
      {showNotes && (
        <CardContent className="pt-0">
          <button
            type="button"
            className="flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
            onClick={() => setNotesExpanded((v) => !v)}
            aria-expanded={notesExpanded}
          >
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform ${notesExpanded ? "rotate-90" : ""}`}
            />
            What's new
          </button>
          {notesExpanded && (
            <pre className="mt-2 max-h-48 overflow-y-auto whitespace-pre-wrap text-xs text-muted-foreground">
              {version.releaseNotes}
            </pre>
          )}
        </CardContent>
      )}
    </Card>
  );
}
