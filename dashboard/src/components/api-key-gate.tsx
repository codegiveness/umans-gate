import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound, RotateCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import { PasswordInput } from "@/components/ui/password-input";
import { useConfigContext } from "@/hooks/use-config-context";

import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "./ui/form";

const schema = z.object({
  umans_api_key: z.string().trim().min(1, "API key is required"),
});

type FormValues = z.infer<typeof schema>;

export function ApiKeyGate() {
  const { config, loading, error, save, restart } = useConfigContext();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { umans_api_key: "" },
  });

  const {
    handleSubmit,
    formState: { isSubmitting },
  } = form;

  const dialogRef = useRef<HTMLDialogElement>(null);
  // After a successful save, the key is on disk but the live ProxyConfig
  // still lacks it (umans_api_key is a restart-required field). We keep the
  // gate open and prompt the user to restart so the key takes effect.
  const [phase, setPhase] = useState<"input" | "saved">("input");
  const [restarting, setRestarting] = useState(false);

  const showGate =
    config !== null &&
    !loading &&
    (!error || phase === "saved") &&
    (!config.has_api_key || phase === "saved");

  useEffect(() => {
    if (error) {
      toast.error("Failed to load configuration", { description: String(error) });
    }
  }, [error]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (showGate && dialog && !dialog.open) {
      dialog.showModal();
    }
  }, [showGate]);

  if (!showGate) return null;

  const onSubmit = async (values: FormValues) => {
    try {
      const result = await save({ umans_api_key: values.umans_api_key });
      if (!result?.ok) {
        toast.error("Failed to save API key", {
          description: result?.errors.join("; ") || "Unknown error",
        });
        return;
      }
      toast.success("API key saved. Restart the service to apply it.");
      setPhase("saved");
    } catch (err) {
      toast.error("Failed to save API key", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
    }
  };

  const handleRestart = async () => {
    setRestarting(true);
    const r = await restart();
    if (!r) {
      toast.error("Restart failed", { description: "Server unreachable." });
      setRestarting(false);
      return;
    }
    if (r.ok) {
      toast.success("Restarting", {
        description:
          r.message ??
          "Server is restarting. Reconnect in a few seconds. Requires a process manager (bun --watch, systemd, pm2) to auto-restart.",
      });
      const poll = async (attempts = 0) => {
        if (attempts > 20) {
          setRestarting(false);
          toast.error("Server did not come back", {
            description: "Check your process manager (bun --watch, systemd, pm2).",
          });
          return;
        }
        try {
          const res = await fetch("/dashboard/api/config", {
            headers: { "Cache-Control": "no-cache" },
          });
          if (res.ok) {
            window.location.reload();
            return;
          }
        } catch {
          // Server still restarting — keep polling.
        }
        setTimeout(() => poll(attempts + 1), 1500);
      };
      poll();
    } else {
      toast.error("Restart failed", { description: r.error });
      setRestarting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 z-[100] m-0 h-screen w-screen bg-background/80 backdrop-blur-sm p-0 border-0"
      aria-label="Umans API key required"
    >
      <div className="flex h-full w-full items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardHeader>
            <div className="flex items-center gap-2">
              <KeyRound className="size-5 text-muted-foreground" />
              <CardTitle>Umans API Key Required</CardTitle>
            </div>
            <CardDescription>
              Enter your Umans API key to start capturing traffic. The key is stored in your local
              config file and can be changed later from the Config tab.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {phase === "input" ? (
              <Form {...form}>
                <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
                  <FormField
                    control={form.control}
                    name="umans_api_key"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>API Key</FormLabel>
                        <FormControl>
                          <PasswordInput
                            placeholder="sk-..."
                            autoComplete="off"
                            autoFocus
                            disabled={isSubmitting}
                            {...field}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button type="submit" disabled={isSubmitting}>
                    {isSubmitting ? "Saving…" : "Save & Continue"}
                  </Button>
                </form>
              </Form>
            ) : (
              <div className="grid gap-4">
                <p className="text-sm text-muted-foreground">
                  Your API key has been saved. Restart the service so the proxy recognizes the new
                  key.
                </p>
                <Button onClick={handleRestart} disabled={restarting}>
                  <RotateCw className="mr-2 size-4" />
                  {restarting ? "Restarting…" : "Restart Service"}
                </Button>
              </div>
            )}
            <p className="mt-3 text-center text-xs text-muted-foreground">
              Don't have a key?{" "}
              <a
                href="https://app.umans.ai"
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-foreground"
              >
                Get one here
              </a>
            </p>
            <p className="mt-3 text-xs text-muted-foreground">
              <strong>Heads up.</strong> Stamping (Claude Code TTL/thinking for Anthropic,
              reasoning_effort for OpenAI) and experimental features — OMO reminder stripping, TTFT
              watchdog with gated retry, and 502/529 ID rewrite — are{" "}
              <strong>enabled by default</strong>. They are anecdotal, not benchmarked. Toggle them
              off in <strong>Config → Stamps</strong> or <strong>Config → Experimental</strong> if
              you prefer a passthrough proxy.
            </p>
          </CardContent>
        </Card>
      </div>
    </dialog>
  );
}
