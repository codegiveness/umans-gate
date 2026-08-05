import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { API_BASE, CONFIG_API_BASE } from "@/lib/constants";

export interface StampModelRuleEntry {
  pattern: string;
  anthropic_thinking_shape?:
    | { type: "adaptive" }
    | { type: "enabled"; keep: "all" }
    | { type: "enabled"; clear_thinking: boolean }
    | { type: "enabled" };
  openai_thinking_shape?:
    | { type: "adaptive" }
    | { type: "enabled"; keep: "all" }
    | { type: "enabled"; clear_thinking: boolean }
    | { type: "enabled" };
  openai_extra_body?: Record<string, unknown>;
  openai_veto_reasoning_effort?: boolean;
  force_thinking_when_absent?: boolean;
}

export interface StampRawConfig {
  stamp_claude_code_enabled?: boolean;
  stamp_model_rules?: StampModelRuleEntry[];
  stamp_reasoning_effort_enabled?: boolean;
}

export interface GateRawConfig {
  concurrency_hard_cap?: number;
  concurrency_soft_limit?: number;
  use_hard_cap?: boolean;
  concurrency_main_reservation?: number;
  concurrency_vision_reservation?: number;
  rate_limit_requests?: number;
  request_use_hard_cap?: boolean;
  request_hard_cap?: number;
  request_soft_limit?: number;
  never_limit_requests?: boolean;
  queue_timeout_ms?: number;
  max_queue_depth?: number;
  release_cooldown_ms?: number;
  breaker_threshold?: number;
  breaker_window_ms?: number;
  breaker_cooldown_ms?: number;
}

export interface VisionRawConfig {
  vision_strategy?: "never" | "catalog" | "always";
  vision_model?: string;
  vision_prompt?: string;
  vision_prompt_version?: number;
  vision_max_images?: number;
  vision_max_description_tokens?: number;
  vision_reasoning_effort?: "none" | "low" | "medium" | "high" | null;
  vision_timeout_ms?: number;
  vision_cache_size?: number;
  vision_cache_ttl_ms?: number;
  vision_cache_max_rows?: number;
  vision_persistent_cache?: boolean;
  vision_concurrency?: number;
  vision_max_dimension?: number;
  vision_jpeg_quality?: number;
  vision_image_format?: "jpeg" | "png";
  vision_image_detail?: "auto" | "low" | "high";
  vision_pending_max_batch?: number;
  vision_intent_strategy?: "off" | "slotted" | "crafted" | "auto";
  vision_decomposition_enabled?: boolean;
  vision_decomposition_timeout_ms?: number;
  vision_crafting_timeout_ms?: number;
  vision_adjacent_text_max_chars?: number;
  vision_recent_messages_count?: number;
  vision_system_prompt_max_chars?: number;
}

export interface UsageHistoryRawConfig {
  usage_history_enabled?: boolean;
  /** Days to retain raw `usage_samples` rows before downsampling into
   *  `usage_daily`. Default 7. Hot-reloadable. The dashboard uses this to
   *  decide whether the per-day timeline renders from raw samples (recent)
   *  or from daily + events (old, ticket 06). */
  usage_raw_retention_days?: number;
  usage_gap_threshold_minutes?: number;
  usage_idle_session_timeout_minutes?: number;
}

export interface ServerRawConfig {
  port?: number;
  max_captures?: number;
  db_path?: string;
  idle_timeout?: number;
  upstream_protocol?: string;
  warmer_enabled?: boolean;
  warmer_interval_ms?: number;
  umans_api_key?: string;
  usage_refresh_ms?: number;
  models_refresh_ms?: number;
  capture_body_max_bytes?: number;
  queue_max_depth?: number;
  ws_backpressure_limit?: number;
  ws_close_on_backpressure_limit?: boolean;
  compression_enabled?: boolean;
  /** Hard timeout for upstream requests in ms. Prevents permit leaks when upstream hangs and client stays connected. Hot-reloadable. */
  upstream_timeout_ms?: number;
  /** Runtime flag: true when the resolved config has an API key (env or file). Read-only — not saved. */
  has_api_key?: boolean;
  /** Runtime flag: true when the resolved config has a dashboard token. Read-only — not saved. */
  has_dashboard_token?: boolean;
  /** Number of latest captures per model used for performance percentile computation. Hot-reloadable. */
  performance_sample_count?: number;
}

export interface ExperimentRawConfig {
  experiment_rewrite_ids?: boolean;
  experiment_rewrite_ttl_ms?: number;
  experiment_strip_omo_reminder?: boolean;
  /** EXPERIMENTAL: Master toggle for TTFT-watchdog gated retry. Hot-reloadable. */
  experiment_ttft_watchdog?: boolean;
  /** Watchdog threshold in ms — abort stalled fetches after this duration. Hot-reloadable. */
  ttft_timeout_ms?: number;
  /** Cap on total upstream attempts (2 = original + 1 retry, 3 = + rewrite escalation). Hot-reloadable. */
  ttft_retry_max_attempts?: number;
  /** Suppress retry when gate active >= this percentage of soft limit. Hot-reloadable. */
  ttft_retry_gate_saturation_pct?: number;
  /** Cooldown between retries in ms. Hot-reloadable. */
  ttft_retry_cooldown_ms?: number;
  /** Multiplier applied to p50 TTFT to compute the dynamic watchdog threshold. Default 5. Hot-reloadable. */
  ttft_watchdog_multiplier?: number;
  /** Hard cap in ms for the dynamic watchdog threshold. Default 300000 (5 min). Hot-reloadable. */
  ttft_watchdog_hard_cap_ms?: number;
}

export interface IncidentRawConfig {
  /** Days to retain incident rows. Default 30. Minimum 1. Hot-reloadable. */
  incident_retention_days?: number;
}

export type RawConfig = StampRawConfig &
  GateRawConfig &
  VisionRawConfig &
  ServerRawConfig &
  UsageHistoryRawConfig &
  ExperimentRawConfig &
  IncidentRawConfig;

export interface ValidationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  normalized?: RawConfig;
}

export interface ReloadResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  applied: string[];
  restartRequired: string[];
  configPath: string;
}

export interface RefreshSourceResult {
  ok: boolean;
  hardCap?: number;
  softLimit?: number;
  requestsLimit?: number | null;
  requestsHardCap?: number | null;
  requestsWindowSeconds?: number | null;
  error?: string;
}

export interface RestartResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export interface SaveResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
  written: RawConfig;
}

export interface ConfigReader {
  config: RawConfig | null;
  loading: boolean;
  error: string | null;
  reload: () => Promise<RawConfig | null>;
}

export interface ConfigWriter {
  save: (patch: RawConfig) => Promise<SaveResult | null>;
  validate: (patch: RawConfig) => Promise<ValidationResult | null>;
}

export interface ConfigOps {
  reloadFromDisk: () => Promise<ReloadResult | null>;
  refreshFromSource: () => Promise<RefreshSourceResult | null>;
  restart: () => Promise<RestartResult | null>;
  resetToDefault: () => Promise<SaveResult | null>;
}

export type UseConfigResult = ConfigReader & ConfigWriter & ConfigOps;

export function useConfig(): UseConfigResult {
  const [config, setConfig] = useState<RawConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await apiFetch(CONFIG_API_BASE);
      if (!r.ok) {
        setError(`HTTP ${r.status}`);
        return null;
      }
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        setError("Backend not reachable");
        return null;
      }
      const data = (await r.json()) as RawConfig;
      setConfig(data);
      return data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Initial fetch.
  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (patch: RawConfig): Promise<SaveResult | null> => {
      try {
        const r = await apiFetch(CONFIG_API_BASE, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        const data = (await r.json()) as SaveResult;
        if (data.ok) {
          // Refresh local copy from disk-truth.
          await reload();
        }
        return data;
      } catch (e) {
        return {
          ok: false,
          errors: [e instanceof Error ? e.message : String(e)],
          warnings: [],
          written: patch,
        };
      }
    },
    [reload],
  );

  const validate = useCallback(async (patch: RawConfig): Promise<ValidationResult | null> => {
    try {
      const r = await apiFetch(`${CONFIG_API_BASE}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) return null;
      return (await r.json()) as ValidationResult;
    } catch {
      return null;
    }
  }, []);

  const reloadFromDisk = useCallback(async (): Promise<ReloadResult | null> => {
    try {
      const r = await apiFetch(`${CONFIG_API_BASE}/reload`, { method: "POST" });
      if (!r.ok) return null;
      const data = (await r.json()) as ReloadResult;
      // After reload, refresh local copy too.
      await reload();
      return data;
    } catch {
      return null;
    }
  }, [reload]);

  const refreshFromSource = useCallback(async (): Promise<RefreshSourceResult | null> => {
    try {
      const r = await apiFetch(`${API_BASE}/usage/refresh-source`, { method: "POST" });
      if (!r.ok) return null;
      const data = (await r.json()) as RefreshSourceResult;
      if (data.ok) {
        await reload();
      }
      return data;
    } catch {
      return null;
    }
  }, [reload]);

  const restart = useCallback(async (): Promise<RestartResult | null> => {
    try {
      const r = await apiFetch(`${API_BASE}/restart`, { method: "POST" });
      if (!r.ok) return null;
      return (await r.json()) as RestartResult;
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }, []);

  const resetToDefault = useCallback(async (): Promise<SaveResult | null> => {
    try {
      const r = await apiFetch(`${CONFIG_API_BASE}/reset`, { method: "POST" });
      const data = (await r.json()) as SaveResult;
      if (data.ok) {
        await reload();
      }
      return data;
    } catch (e) {
      return {
        ok: false,
        errors: [e instanceof Error ? e.message : String(e)],
        warnings: [],
        written: null as unknown as RawConfig,
      };
    }
  }, [reload]);

  return {
    config,
    loading,
    error,
    reload,
    save,
    validate,
    reloadFromDisk,
    refreshFromSource,
    restart,
    resetToDefault,
  };
}
