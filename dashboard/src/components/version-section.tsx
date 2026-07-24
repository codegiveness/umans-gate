import { AlertCircle, Check, ChevronRight, Loader2, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useVersion, type VersionInfo } from "@/hooks/use-version";
import { apiFetch } from "@/lib/api";

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
        <CardContent className="text-xs text-muted-foreground">Checking version…</CardContent>
      </Card>
    );
  }

  if (!version) {
    return null;
  }

  if (version.error) {
    return (
      <Card>
        <CardContent className="flex items-center justify-between">
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

type UpdateState = "idle" | "updating" | "timeout" | "error";

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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [blockerOpen, setBlockerOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>("idle");
  const [targetVersion, setTargetVersion] = useState<string | null>(null);
  const [updateError, setUpdateError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotes = version.updateAvailable && version.releaseNotes !== null;
  const canShowUpdateButton = version.updateAvailable && version.latest !== null;

  useEffect(() => {
    if (updateState !== "updating") return;

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch("/health");
        if (res.status === 200 || res.status === 401) {
          window.location.reload();
        }
      } catch {
        // server still down — keep polling
      }
    }, 2000);

    timeoutRef.current = setTimeout(() => {
      setUpdateState("timeout");
    }, 120000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [updateState]);

  async function handleConfirm() {
    setConfirmOpen(false);
    setUpdateError(null);
    setUpdateState("updating");
    try {
      const res = await apiFetch("/dashboard/api/update", { method: "POST" });
      const data = (await res.json()) as { ok: boolean; targetVersion?: string; error?: string };
      if (data.ok && data.targetVersion) {
        setTargetVersion(data.targetVersion);
      } else {
        setUpdateState("error");
        setUpdateError(data.error ?? "unknown");
      }
    } catch {
      setUpdateState("error");
      setUpdateError("network");
    }
  }

  if (updateState === "updating" || updateState === "timeout" || updateState === "error") {
    const displayVersion = targetVersion ?? version.latest ?? "latest";
    return (
      <>
        <div className="fixed inset-0 z-40 bg-background/60 backdrop-blur-sm" />
        <Card className="relative z-50 mx-auto mt-16 max-w-md">
          <CardContent className="flex flex-col items-center gap-3 py-6 text-center">
            {updateState === "error" ? (
              <>
                <AlertCircle className="h-8 w-8 text-destructive" />
                <p className="text-sm">
                  Update failed:{" "}
                  {updateError === "already_up_to_date"
                    ? "already up to date"
                    : updateError === "not_service_managed"
                      ? "not running as a service"
                      : updateError === "token_not_set"
                        ? "dashboard token not configured"
                        : "unexpected error"}
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setUpdateState("idle");
                    setUpdateError(null);
                  }}
                >
                  Dismiss
                </Button>
              </>
            ) : updateState === "timeout" ? (
              <>
                <AlertCircle className="h-8 w-8 text-amber-500" />
                <p className="text-sm">
                  Update is taking longer than expected. Check{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    umans-gate service logs
                  </code>
                  .
                </p>
              </>
            ) : (
              <>
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p className="text-sm">Updating to v{displayVersion}… reconnecting…</p>
              </>
            )}
          </CardContent>
        </Card>
      </>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center justify-between gap-3">
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
        <div className="flex items-center gap-2">
          {canShowUpdateButton && (
            <UpdateButton
              latest={version.latest as string}
              onClick={() => (version.canUpdate ? setConfirmOpen(true) : setBlockerOpen(true))}
            />
          )}
          <Button size="sm" variant="ghost" disabled={checking} onClick={onCheck}>
            <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${checking ? "animate-spin" : ""}`} />
            {checking ? "Checking…" : "Check now"}
          </Button>
        </div>
      </CardContent>
      {showNotes && (
        <CardContent>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setNotesExpanded((v) => !v)}
            aria-expanded={notesExpanded}
          >
            <ChevronRight
              className={`h-3.5 w-3.5 transition-transform ${notesExpanded ? "rotate-90" : ""}`}
            />
            What's new
          </Button>
          {notesExpanded && (
            <ScrollArea className="mt-2 h-48">
              <pre className="whitespace-pre-wrap text-xs text-muted-foreground">
                {version.releaseNotes}
              </pre>
            </ScrollArea>
          )}
        </CardContent>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Update to v{version.latest}?</AlertDialogTitle>
            <AlertDialogDescription>
              This will stop the proxy, update to v{version.latest}, and restart. Your connection
              will drop and reconnect automatically.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleConfirm()}>Update</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={blockerOpen} onOpenChange={setBlockerOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cannot update automatically</AlertDialogTitle>
            <AlertDialogDescription>
              {version.canUpdateReason === "no_token" ? (
                "One-click update requires DASHBOARD_TOKEN to be set. Configure it in the Config tab and restart the server."
              ) : version.canUpdateReason === "no_service" ? (
                <>
                  One-click update requires the proxy to run as a managed service. Run{" "}
                  <code className="rounded bg-muted px-1 py-0.5 text-xs">
                    umans-gate service install
                  </code>{" "}
                  in your terminal.
                </>
              ) : (
                "One-click update is not available."
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setBlockerOpen(false)}>Close</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}

function UpdateButton({ latest, onClick }: { latest: string; onClick: () => void }) {
  return (
    <Button size="sm" variant="default" onClick={onClick}>
      Update to v{latest}
    </Button>
  );
}
