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
    setDraft((prev) => {
      if (!prev) return prev;
      const next = { ...prev, [key]: v };
      // Auto-reset GLM 5.2 thinking child when parent stamp turns off
      if (key === "stamp_claude_code_enabled" && v === false) {
        next.stamp_glm_5_2_thinking_enabled = false;
      }
      return next;
    });
  }

  return { draft, setDraft, resetDraft, updateField, isDirty: dirtyKeys.size > 0, dirtyKeys };
}
