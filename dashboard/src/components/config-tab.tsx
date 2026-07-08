import { AlertCircle, Download, Power, RotateCcw, RotateCw } from "lucide-react";
import { useMemo } from "react";

import { SectionBlock } from "@/components/config-fields";
import { SECTIONS } from "@/components/config-sections";
import type { SectionDef } from "@/components/config-sections";
import { Button } from "@/components/ui/button";
import { Loader } from "@/components/ui/loader";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { type RawConfig, useConfig } from "@/hooks/use-config";
import { useConfigDraft } from "@/hooks/use-config-draft";
import { useConfigMutation } from "@/hooks/use-config-mutation";
import { useModels } from "@/hooks/use-models";
import { validateConfigDraft } from "@/lib/config-validation";

export function ConfigTab() {
  const {
    config,
    loading,
    error,
    reload,
    save,
    validate,
    reloadFromDisk,
    refreshFromSource,
    restart,
  } = useConfig();
  const { data: modelsData } = useModels();

  const { draft, updateField, resetDraft, isDirty, dirtyKeys } = useConfigDraft(config);
  const {
    save: handleSave,
    validate: handleValidate,
    reloadFromDisk: handleReload,
    refreshFromSource: handleRefreshSource,
    restart: handleRestart,
    reset: handleReset,
    loading: mutationLoading,
    validationErrors,
    setValidationErrors,
  } = useConfigMutation({
    draft,
    dirtyKeys,
    isDirty,
    resetDraft,
    save,
    validate,
    reloadFromDisk,
    refreshFromSource,
    restart,
  });

  const sectionsWithVisionModels = useMemo<SectionDef[]>(() => {
    const visionModels = (modelsData?.models ?? [])
      .filter((m) => m.info?.capabilities.supports_vision === true)
      .map((m) => ({ value: m.id, label: m.id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return SECTIONS.map((s) =>
      s.title === "Vision"
        ? {
            ...s,
            fields: s.fields.map((f) =>
              f.key === "vision_model" ? { ...f, options: visionModels } : f,
            ),
          }
        : s,
    );
  }, [modelsData]);

  const clientErrors = useMemo<Record<string, string>>(() => {
    if (!draft) return {};
    return validateConfigDraft(draft, sectionsWithVisionModels);
  }, [draft, sectionsWithVisionModels]);
  const hasClientErrors = Object.keys(clientErrors).length > 0;

  // Clear validation errors when the user edits a field.
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
            <TooltipContent side="bottom">Write changed fields to disk</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={mutationLoading.validating}
                onClick={handleValidate}
              >
                {mutationLoading.validating ? "Validating…" : "Validate"}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Check draft for errors without saving</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={mutationLoading.reloading}
                onClick={handleReload}
              >
                {mutationLoading.reloading ? "Reloading…" : "Reload from Disk"}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Re-read config.json and apply live</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                size="sm"
                variant="outline"
                disabled={mutationLoading.refreshingSource}
                onClick={handleRefreshSource}
              >
                <Download className="mr-1.5 h-3.5 w-3.5" />
                {mutationLoading.refreshingSource ? "Fetching…" : "Reload Limits from Source"}
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom" className="max-w-[260px]">
              Re-fetch hard cap and soft limit from upstream rate-limit headers
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
          {sectionsWithVisionModels.map((s, i) => (
            <SectionBlock
              key={s.title}
              section={s}
              values={draft}
              originals={config ?? {}}
              onField={onField}
              errors={clientErrors}
              isLast={i === sectionsWithVisionModels.length - 1}
            />
          ))}
          <div className="pt-6 text-xs text-muted-foreground">
            Fields marked{" "}
            <span className="text-muted-foreground">
              <RotateCw className="inline h-3 w-3 mr-1" aria-hidden />
              restart
            </span>{" "}
            require a server restart to take effect. Other fields can be applied live via{" "}
            <span className="font-mono">Reload from Disk</span> after saving.
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
