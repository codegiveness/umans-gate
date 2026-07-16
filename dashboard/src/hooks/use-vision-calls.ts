import { usePollingResource } from "@/hooks/use-polling-resource";
import { apiFetch } from "@/lib/api";
import { API_BASE } from "@/lib/constants";
import type { VisionCallRecord } from "@/types/vision";
const POLL_INTERVAL = 5000;

export interface UseVisionCallsResult {
  records: VisionCallRecord[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
  clear: () => void;
}

export function useVisionCalls(): UseVisionCallsResult {
  const parse = (value: unknown): VisionCallRecord[] =>
    value === undefined ? [] : (value as VisionCallRecord[]);

  const {
    data: records,
    loading,
    error,
    refresh,
  } = usePollingResource<VisionCallRecord[]>({
    endpoint: "/vision-calls",
    pollInterval: POLL_INTERVAL,
    errorMessage: "Failed to fetch vision calls",
    parse,
  });

  const clear = async () => {
    try {
      await apiFetch(`${API_BASE}/vision-calls`, { method: "DELETE" });
      refresh();
    } catch (err) {
      // Ignore: the next poll will reconcile the server state anyway.
    }
  };

  return { records, loading, error, refresh, clear };
}
