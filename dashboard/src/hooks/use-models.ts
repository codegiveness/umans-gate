import { usePollingResource } from "@/hooks/use-polling-resource";
import type { ModelsResponse } from "@/types";

const POLL_INTERVAL = 30000;

export interface UseModelsResult {
  data: ModelsResponse | null;
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

export function useModels(): UseModelsResult {
  const parse = (value: unknown): ModelsResponse | null =>
    value === undefined ? null : (value as ModelsResponse);

  const { data, loading, error, refresh } = usePollingResource<ModelsResponse | null>({
    endpoint: "/models",
    pollInterval: POLL_INTERVAL,
    errorMessage: "Failed to fetch models",
    parse,
  });

  return { data, loading, error, refresh };
}
