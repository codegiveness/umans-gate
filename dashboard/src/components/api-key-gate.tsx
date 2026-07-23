import { zodResolver } from "@hookform/resolvers/zod";
import { KeyRound } from "lucide-react";
import { useEffect, useRef } from "react";
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
  const { config, loading, error, save } = useConfigContext();

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { umans_api_key: "" },
  });

  const {
    handleSubmit,
    formState: { isSubmitting },
  } = form;

  const dialogRef = useRef<HTMLDialogElement>(null);

  const showGate = config !== null && !loading && !error && !config.has_api_key;

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
      toast.success("API key saved. Reloading configuration…");
    } catch (err) {
      toast.error("Failed to save API key", {
        description: err instanceof Error ? err.message : "Unknown error",
      });
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
          </CardContent>
        </Card>
      </div>
    </dialog>
  );
}
