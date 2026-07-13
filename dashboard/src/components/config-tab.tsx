import { AlertCircle, Power, RotateCcw, RotateCw } from "lucide-react";
import { useMemo, useState } from "react";

import { GroupBlock } from "@/components/config-fields";
import { GROUPS } from "@/components/config-sections";
import type { GroupDef } from "@/components/config-sections";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { RawConfig } from "@/hooks/use-config";
import { useConfigContext } from "@/hooks/use-config-context";
import { useConfigDraft } from "@/hooks/use-config-draft";
import { useConfigMutation } from "@/hooks/use-config-mutation";
import { useModels } from "@/hooks/use-models";
import { useUsage } from "@/hooks/use-usage";
import { validateConfigDraft } from "@/lib/config-validation";

export function ConfigTab() {
  const {
    config,
    loading,
    error,
    reload,
    save,
    reloadFromDisk,
    refreshFromSource,
    restart,
    resetToDefault,
  } = useConfigContext();
  const { data: modelsData } = useModels();
  const { data: usage } = useUsage();

  const { draft, updateField, resetDraft, isDirty, dirtyKeys } = useConfigDraft(config);
  const {
    save: handleSave,
    refreshFromSource: handleRefreshSource,
    restart: handleRestart,
    reset: handleReset,
    resetToDefault: handleResetToDefault,
    loading: mutationLoading,
    validationErrors,
    setValidationErrors,
  } = useConfigMutation({
    draft,
    dirtyKeys,
    isDirty,
    resetDraft,
    save,
    reloadFromDisk,
    refreshFromSource,
    restart,
    resetToDefault,
  });

  const [resetDialogOpen, setResetDialogOpen] = useState(false);

  const groupsWithOverrides = useMemo<GroupDef[]>(() => {
    const visionModels = (modelsData?.models ?? [])
      .filter((m) => m.info?.capabilities.supports_vision === true)
      .map((m) => ({ value: m.id, label: m.id }))
      .sort((a, b) => a.label.localeCompare(b.label));

    const hardCap = usage?.concurrencyHardCap ?? undefined;
    const resMax = hardCap !== undefined ? hardCap - 2 : undefined;
    const rateMax = usage?.requestsHardCap ?? undefined;

    const fieldMaxOverride: Partial<Record<string, number | undefined>> = {};
    if (hardCap !== undefined) {
      fieldMaxOverride.concurrency_hard_cap = hardCap;
      fieldMaxOverride.concurrency_soft_limit = hardCap;
      fieldMaxOverride.concurrency_main_reservation = resMax;
      fieldMaxOverride.concurrency_vision_reservation = resMax;
    }
    if (rateMax !== undefined) {
      fieldMaxOverride.rate_limit_requests = rateMax;
    }

    return GROUPS.map((g) => ({
      ...g,
      sections: g.sections.map((s) => ({
        ...s,
        fields: s.fields.map((f) => {
          let patched = f;
          if (f.key === "vision_model") {
            patched = { ...patched, options: visionModels };
          }
          if (f.key in fieldMaxOverride) {
            patched = { ...patched, max: fieldMaxOverride[f.key] };
          }
          return patched;
        }),
      })),
    }));
  }, [modelsData, usage]);

  const { errors: clientErrors, warnings: clientWarnings } = useMemo(() => {
    if (!draft) return { errors: {}, warnings: {} };
    const allSections = groupsWithOverrides.flatMap((g) => g.sections);
    return validateConfigDraft(draft, allSections);
  }, [draft, groupsWithOverrides]);
  const hasClientErrors = Object.keys(clientErrors).length > 0;

  function onField(key: keyof RawConfig, v: unknown) {
    if (draft) updateField(key, v);
    if (validationErrors.length > 0) setValidationErrors([]);
  }

  if (loading && !draft) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader />
      </div>
    );
  }

  if (error && !draft) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-muted-foreground">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <p className="text-sm font-medium text-destructive">Something went wrong</p>
        <p className="text-xs">{error}</p>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="outline" size="sm" onClick={reload}>
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
              Retry
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Retry loading config</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  if (!draft) return null;

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
        <h2 className="sr-only">Configuration</h2>
        <div className="flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="default"
                disabled={mutationLoading.saving || !isDirty || hasClientErrors}
                onClick={handleSave}
              >
                {mutationLoading.saving ? "Saving…" : "Save"}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Save changes to disk and apply live fields automatically
            </TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button size="sm" variant="ghost" disabled={!isDirty} onClick={handleReset}>
                Reset Draft
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Discard unsaved changes</TooltipContent>
          </Tooltip>
          <AlertDialog open={resetDialogOpen} onOpenChange={setResetDialogOpen}>
            <Tooltip>
              <TooltipTrigger asChild>
                <AlertDialogTrigger
                  render={
                    <Button size="sm" variant="outline" disabled={mutationLoading.resetting}>
                      <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                      {mutationLoading.resetting ? "Resetting…" : "Reset to Default"}
                    </Button>
                  }
                />
              </TooltipTrigger>
              <TooltipContent side="bottom">
                Reset all config fields to defaults (API key is preserved)
              </TooltipContent>
            </Tooltip>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Reset all config to defaults?</AlertDialogTitle>
                <AlertDialogDescription>
                  This writes the default configuration to disk, replacing all current values. Your
                  API key is preserved. A restart will be needed for some fields to take effect.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  onClick={async () => {
                    setResetDialogOpen(false);
                    await handleResetToDefault();
                  }}
                >
                  Reset to Default
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="destructive"
                disabled={mutationLoading.restarting}
                onClick={handleRestart}
              >
                <Power className="mr-1.5 h-3.5 w-3.5" />
                {mutationLoading.restarting ? "Restarting…" : "Restart"}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px]">
              Restart the server. Requires an external process manager (bun --watch, systemd, pm2).
            </TooltipContent>
          </Tooltip>
        </div>
        {isDirty ? (
          <span className="text-xs text-muted-foreground">
            {dirtyKeys.size} unsaved change{dirtyKeys.size > 1 ? "s" : ""}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">All changes saved</span>
        )}
      </header>
      {validationErrors.length > 0 && (
        <div
          role="alert"
          aria-live="polite"
          className="border-b border-destructive/30 bg-destructive/5 px-4 py-2"
        >
          <p className="text-xs font-medium text-destructive">
            {validationErrors.length === 1 ? "1 issue" : `${validationErrors.length} issues`}
          </p>
          <ul className="mt-1 space-y-0.5">
            {validationErrors.map((e) => (
              <li key={e} className="text-xs text-destructive/80">
                {e}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto w-full max-w-3xl px-6 py-6">
          {groupsWithOverrides.map((g, gi) => (
            <GroupBlock
              key={g.title}
              group={g}
              values={draft}
              originals={config ?? {}}
              onField={onField}
              errors={clientErrors}
              warnings={clientWarnings}
              isLast={gi === groupsWithOverrides.length - 1}
              onRefreshSource={handleRefreshSource}
              refreshingSource={mutationLoading.refreshingSource}
            />
          ))}
          <div className="pt-6 text-xs text-muted-foreground">
            Fields marked{" "}
            <span className="text-muted-foreground">
              <RotateCw className="inline h-3 w-3 mr-1" aria-hidden />
              restart
            </span>{" "}
            require a server restart to take effect. Other fields are applied live when you save.
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
