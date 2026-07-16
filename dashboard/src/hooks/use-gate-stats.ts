import { useCallback, useState } from "react";

import { apiFetch } from "@/lib/api";
import { API_BASE } from "@/lib/constants";
import type { GateStats } from "@/types";

/**
 * Manages fetching and live-updating gate stats.
 *
 * The orchestrator wires `setGateStats` to the socket `gate` handler, and
 * calls `loadGate` on initial mount and on socket reconnect.
 */
export interface UseGateStatsResult {
  gateStats: GateStats | null;
  setGateStats: React.Dispatch<React.SetStateAction<GateStats | null>>;
  gateError: string | null;
  loadGate: () => Promise<void>;
  retryGate: () => void;
}

export function useGateStats(): UseGateStatsResult {
  const [gateStats, setGateStats] = useState<GateStats | null>(null);
  const [gateError, setGateError] = useState<string | null>(null);

  const loadGate = useCallback(async () => {
    try {
      const r = await apiFetch(`${API_BASE}/gate`);
      if (!r.ok) {
        setGateError(`HTTP ${r.status} ${r.statusText}`);
        return;
      }
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) {
        return;
      }
      setGateStats((await r.json()) as GateStats);
      setGateError(null);
    } catch (e) {
      setGateError(String(e));
    }
  }, []);

  const retryGate = useCallback(() => {
    void loadGate();
  }, [loadGate]);

  return {
    gateStats,
    setGateStats,
    gateError,
    loadGate,
    retryGate,
  };
}
