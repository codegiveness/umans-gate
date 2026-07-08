import { type Dispatch, type SetStateAction, useEffect, useMemo, useState } from "react";

import type { RawConfig } from "@/hooks/use-config";

export interface UseConfigDraftResult {
  draft: RawConfig | null;
  setDraft: Dispatch<SetStateAction<RawConfig | null>>;
  resetDraft: () => void;
  updateField: (key: keyof RawConfig, v: unknown) => void;
  isDirty: boolean;
  dirtyKeys: Set<keyof RawConfig>;
}

/**
 * Manages the editable draft state for the config tab.
 * Syncs from `initialConfig` when a fresh config arrives,
 * tracks dirty keys, and provides field-level updates.
 */
export function useConfigDraft(initialConfig: RawConfig | null): UseConfigDraftResult {
  const [draft, setDraft] = useState<RawConfig | null>(null);

  // Sync draft when fresh config arrives.
  useEffect(() => {
    if (initialConfig) setDraft({ ...initialConfig });
  }, [initialConfig]);

  const dirtyKeys = useMemo(() => {
    if (!draft || !initialConfig) return new Set<keyof RawConfig>();
    const keys = new Set<keyof RawConfig>();
    for (const k of Object.keys(draft) as (keyof RawConfig)[]) {
      if (JSON.stringify(draft[k] ?? null) !== JSON.stringify(initialConfig[k] ?? null)) {
        keys.add(k);
      }
    }
    return keys;
  }, [draft, initialConfig]);

  function resetDraft() {
    if (initialConfig) setDraft({ ...initialConfig });
  }

  function updateField(key: keyof RawConfig, v: unknown) {
    setDraft((prev) => (prev ? { ...prev, [key]: v } : prev));
  }

  return { draft, setDraft, resetDraft, updateField, isDirty: dirtyKeys.size > 0, dirtyKeys };
}
