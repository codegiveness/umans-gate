import { useCallback, useState } from "react";
import { toast } from "sonner";

import type {
  RawConfig,
  RefreshSourceResult,
  ReloadResult,
  RestartResult,
  SaveResult,
} from "@/hooks/use-config";

export interface ConfigApi {
  draft: RawConfig | null;
  dirtyKeys: Set<keyof RawConfig>;
  isDirty: boolean;
  resetDraft: () => void;
  save: (patch: RawConfig) => Promise<SaveResult | null>;
  reloadFromDisk: () => Promise<ReloadResult | null>;
  refreshFromSource: () => Promise<RefreshSourceResult | null>;
  restart: () => Promise<RestartResult | null>;
  resetToDefault: () => Promise<SaveResult | null>;
}

export interface UseConfigMutationResult {
  save: () => Promise<void>;
  refreshFromSource: () => Promise<void>;
  restart: () => Promise<void>;
  reset: () => void;
  resetToDefault: () => Promise<void>;
  loading: {
    saving: boolean;
    refreshingSource: boolean;
    restarting: boolean;
    resetting: boolean;
  };
  validationErrors: string[];
  setValidationErrors: (errors: string[]) => void;
}

/**
 * Manages mutation actions for the config tab: save (+ auto-reload),
 * refresh-from-source, restart, and reset.
 * Validation is field-level (live clientErrors) — no standalone validate button.
 * Reload-from-disk is auto-triggered after a successful save to apply hot fields.
 */
export function useConfigMutation(api: ConfigApi): UseConfigMutationResult {
  const [saving, setSaving] = useState(false);
  const [refreshingSource, setRefreshingSource] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);

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
    if (!r) {
      setSaving(false);
      toast.error("Save failed", { description: "Server unreachable." });
      setValidationErrors(["Server unreachable."]);
      return;
    }
    if (r.ok) {
      // Auto-reload from disk to apply hot fields live.
      const reloaded = await api.reloadFromDisk();
      setSaving(false);
      if (reloaded?.ok) {
        toast.success("Config saved", {
          description: r.warnings.length
            ? `${r.warnings.length} warning(s)`
            : "Saved and applied live.",
        });
      } else {
        toast.warning("Config saved", {
          description: "Saved to disk, but live reload failed. Restart to apply.",
        });
      }
      setValidationErrors([]);
    } else {
      setSaving(false);
      toast.error("Save rejected", { description: r.errors.join("\n") });
      setValidationErrors(r.errors);
    }
    if (r.warnings.length) {
      for (const w of r.warnings) toast.warning("Warning", { description: w });
    }
  }, [api]);

  const handleReset = useCallback(() => {
    api.resetDraft();
    toast.info("Draft reset", { description: "Reverted to last loaded config." });
  }, [api]);

  const handleResetToDefault = useCallback(async () => {
    setResetting(true);
    const r = await api.resetToDefault();
    setResetting(false);
    if (!r) {
      toast.error("Reset failed", { description: "Server unreachable." });
      return;
    }
    if (r.ok) {
      toast.success("Config reset to defaults", {
        description: "API key preserved. Limits refetched from upstream.",
      });
      setValidationErrors([]);
    } else {
      toast.error("Reset failed", { description: r.errors.join("\n") });
    }
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
      const parts = [`Hard cap set to ${r.hardCap}`, `soft limit set to ${r.softLimit}`];
      if (r.requestsHardCap !== null && r.requestsHardCap !== undefined) {
        parts.push(`rate limit hard cap set to ${r.requestsHardCap}`);
      } else {
        parts.push("rate limit: unlimited");
      }
      toast.success("Limits reloaded from source", {
        description: `${parts.join(", ")}.`,
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
        description:
          r.message ??
          "Server is restarting. Reconnect in a few seconds. Requires a process manager (bun --watch, systemd, pm2) to auto-restart.",
      });
      // Reset button after 5s — if a process manager restarts the server,
      // the page will reconnect via WebSocket and reload anyway.
      setTimeout(() => setRestarting(false), 5000);
    } else {
      toast.error("Restart failed", { description: r.error });
      setRestarting(false);
    }
  }, [api]);

  return {
    save: handleSave,
    refreshFromSource: handleRefreshSource,
    restart: handleRestart,
    reset: handleReset,
    resetToDefault: handleResetToDefault,
    loading: {
      saving,
      refreshingSource,
      restarting,
      resetting,
    },
    validationErrors,
    setValidationErrors,
  };
}
