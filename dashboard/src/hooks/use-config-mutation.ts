import { useCallback, useState } from "react";
import { toast } from "sonner";

import type {
  RawConfig,
  RefreshSourceResult,
  ReloadResult,
  RestartResult,
  SaveResult,
  ValidationResult,
} from "@/hooks/use-config";

export interface ConfigApi {
  draft: RawConfig | null;
  dirtyKeys: Set<keyof RawConfig>;
  isDirty: boolean;
  resetDraft: () => void;
  save: (patch: RawConfig) => Promise<SaveResult | null>;
  validate: (patch: RawConfig) => Promise<ValidationResult | null>;
  reloadFromDisk: () => Promise<ReloadResult | null>;
  refreshFromSource: () => Promise<RefreshSourceResult | null>;
  restart: () => Promise<RestartResult | null>;
}

export interface UseConfigMutationResult {
  save: () => Promise<void>;
  validate: () => Promise<void>;
  reloadFromDisk: () => Promise<void>;
  refreshFromSource: () => Promise<void>;
  restart: () => Promise<void>;
  reset: () => void;
  loading: {
    saving: boolean;
    validating: boolean;
    reloading: boolean;
    refreshingSource: boolean;
    restarting: boolean;
  };
  validationErrors: string[];
  setValidationErrors: (errors: string[]) => void;
}

/**
 * Manages all mutation actions for the config tab: save, validate,
 * reload-from-disk, refresh-from-source, restart, and reset.
 * Each action handles its own loading state, toast notifications,
 * and validation error collection — preserving the exact behavior
 * that previously lived inline in ConfigTab.
 */
export function useConfigMutation(api: ConfigApi): UseConfigMutationResult {
  const [saving, setSaving] = useState(false);
  const [validating, setValidating] = useState(false);
  const [refreshingSource, setRefreshingSource] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

  const handleValidate = useCallback(async () => {
    if (!api.draft) return;
    setValidating(true);
    const r = await api.validate(api.draft);
    setValidating(false);
    if (!r) {
      toast.error("Validate failed", { description: "Server unreachable." });
      setValidationErrors(["Server unreachable."]);
      return;
    }
    if (r.ok) {
      toast.success("Validation passed", {
        description: r.warnings.length ? `${r.warnings.length} warning(s)` : "No warnings.",
      });
      setValidationErrors([]);
    } else {
      toast.error("Validation failed", {
        description: r.errors.join("\n"),
      });
      setValidationErrors(r.errors);
    }
    if (r.warnings.length) {
      for (const w of r.warnings) toast.warning("Warning", { description: w });
    }
  }, [api]);

  const handleSave = useCallback(async () => {
    if (!api.draft) return;
    if (!api.isDirty) {
      toast.info("Nothing to save", { description: "No changes since last load." });
      return;
    }
    setSaving(true);
    // Only send dirty keys — avoids clobbering fields the UI doesn't render.
    const patch: Record<string, unknown> = {};
    for (const k of api.dirtyKeys) patch[k] = api.draft[k];
    const r = await api.save(patch as RawConfig);
    setSaving(false);
    if (!r) {
      toast.error("Save failed", { description: "Server unreachable." });
      setValidationErrors(["Server unreachable."]);
      return;
    }
    if (r.ok) {
      toast.success("Config saved", {
        description: r.warnings.length ? `${r.warnings.length} warning(s)` : "Saved to disk.",
      });
      setValidationErrors([]);
    } else {
      toast.error("Save rejected", { description: r.errors.join("\n") });
      setValidationErrors(r.errors);
    }
    if (r.warnings.length) {
      for (const w of r.warnings) toast.warning("Warning", { description: w });
    }
  }, [api]);

  const handleReload = useCallback(async () => {
    setReloading(true);
    const r = await api.reloadFromDisk();
    setReloading(false);
    if (!r) {
      toast.error("Reload failed", { description: "Server unreachable." });
      return;
    }
    if (r.ok) {
      toast.success("Config reloaded", {
        description: r.restartRequired.length
          ? `${r.applied.length} applied, ${r.restartRequired.length} need restart.`
          : `${r.applied.length} field(s) applied live.`,
      });
    } else {
      toast.error("Reload failed", { description: r.errors.join("\n") });
    }
    if (r.warnings.length) {
      for (const w of r.warnings) toast.warning("Warning", { description: w });
    }
  }, [api]);

  const handleReset = useCallback(() => {
    api.resetDraft();
    toast.info("Draft reset", { description: "Reverted to last loaded config." });
  }, [api]);

  const handleRefreshSource = useCallback(async () => {
    setRefreshingSource(true);
    const r = await api.refreshFromSource();
    setRefreshingSource(false);
    if (!r) {
      toast.error("Refresh failed", { description: "Server unreachable." });
      return;
    }
    if (r.ok) {
      toast.success("Limits reloaded from source", {
        description: `Hard cap set to ${r.hardCap}, soft limit set to ${r.softLimit}.`,
      });
    } else {
      toast.error("Refresh failed", { description: r.error });
    }
  }, [api]);

  const handleRestart = useCallback(async () => {
    setRestarting(true);
    const r = await api.restart();
    if (!r) {
      toast.error("Restart failed", { description: "Server unreachable." });
      setRestarting(false);
      return;
    }
    if (r.ok) {
      toast.success("Restarting", {
        description: r.message ?? "Server is restarting. Reconnect in a few seconds.",
      });
    } else {
      toast.error("Restart failed", { description: r.error });
      setRestarting(false);
    }
  }, [api]);

  return {
    save: handleSave,
    validate: handleValidate,
    reloadFromDisk: handleReload,
    refreshFromSource: handleRefreshSource,
    restart: handleRestart,
    reset: handleReset,
    loading: {
      saving,
      validating,
      reloading,
      refreshingSource,
      restarting,
    },
    validationErrors,
    setValidationErrors,
  };
}
