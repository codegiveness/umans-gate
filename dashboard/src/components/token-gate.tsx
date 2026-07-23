import { ShieldCheck } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { PasswordInput } from "@/components/ui/password-input";
import { clearDashboardToken, setDashboardToken, UNAUTHORIZED_EVENT } from "@/lib/api";

import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";

/**
 * Modal gate shown when the dashboard API returns 401 (dashboard token required).
 * Prompts the user to enter the token, stores it in sessionStorage, then dismisses.
 * Also shown on initial load if a token is already stored but may be stale.
 */
export function TokenGate() {
  const [open, setOpen] = useState(false);
  const [token, setToken] = useState("");
  const [verifying, setVerifying] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const handler = () => {
      clearDashboardToken();
      setToken("");
      setOpen(true);
    };
    window.addEventListener(UNAUTHORIZED_EVENT, handler);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, handler);
  }, []);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (open && dialog && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog?.open) {
      dialog.close();
    }
  }, [open]);

  if (!open) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token.trim()) return;

    setVerifying(true);
    setDashboardToken(token.trim());

    // Verify by fetching the config endpoint.
    try {
      const res = await fetch("/dashboard/api/config", {
        headers: { Authorization: `Bearer ${token.trim()}` },
      });
      if (res.ok) {
        setOpen(false);
        toast.success("Authentication successful");
        // Reload the page to reinitialize all hooks with the token.
        window.location.reload();
      } else if (res.status === 401) {
        toast.error("Invalid token", { description: "The dashboard token was rejected." });
        clearDashboardToken();
      } else {
        toast.error(`Unexpected response (HTTP ${res.status})`);
        clearDashboardToken();
      }
    } catch {
      toast.error("Failed to verify token", { description: "Server unreachable." });
      clearDashboardToken();
    } finally {
      setVerifying(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-[100] m-0 h-screen w-screen bg-background/80 backdrop-blur-sm p-0 border-0"
      aria-label="Dashboard token required"
    >
      <div className="flex h-full w-full items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-muted-foreground" />
              <CardTitle>Dashboard Token Required</CardTitle>
            </div>
            <CardDescription>
              This dashboard is protected with a token. Enter it below to access the dashboard.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="grid gap-4">
              <div className="grid gap-2">
                <label htmlFor="dashboard-token" className="text-sm font-medium">
                  Dashboard Token
                </label>
                <PasswordInput
                  id="dashboard-token"
                  placeholder="Enter dashboard token"
                  autoComplete="off"
                  autoFocus
                  disabled={verifying}
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={verifying || !token.trim()}>
                {verifying ? "Verifying…" : "Connect"}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </dialog>
  );
}
