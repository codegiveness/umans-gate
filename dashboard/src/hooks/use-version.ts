import { useCallback, useEffect, useState } from "react";

import { apiFetch } from "@/lib/api";
import { VERSION_API_BASE } from "@/lib/constants";

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  lastCheckedAt: number | null;
  error: string | null;
  releaseNotes: string | null;
  canUpdate: boolean;
  canUpdateReason: string | null;
}

export interface UseVersionResult {
  version: VersionInfo | null;
  loading: boolean;
  checking: boolean;
  checkNow: () => Promise<void>;
}

export function useVersion(): UseVersionResult {
  const [version, setVersion] = useState<VersionInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [checking, setChecking] = useState(false);

  const fetchVersion = useCallback(async () => {
    try {
      const r = await apiFetch(VERSION_API_BASE);
      if (!r.ok) return null;
      const ct = r.headers.get("content-type") ?? "";
      if (!ct.includes("application/json")) return null;
      const data = (await r.json()) as VersionInfo;
      setVersion(data);
      return data;
    } catch {
      return null;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      await fetchVersion();
      if (cancelled) return;
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [fetchVersion]);

  const checkNow = useCallback(async () => {
    setChecking(true);
    try {
      const r = await apiFetch(`${VERSION_API_BASE}/check`, { method: "POST" });
      if (r.ok) {
        const data = (await r.json()) as VersionInfo;
        setVersion(data);
      }
    } catch {
      // ignore — version stays at last known state
    } finally {
      setChecking(false);
    }
  }, []);

  return { version, loading, checking, checkNow };
}
