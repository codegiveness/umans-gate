import { createContext, type ReactNode, useContext } from "react";

import { type UseConfigResult, useConfig } from "@/hooks/use-config";

const ConfigContext = createContext<UseConfigResult | null>(null);

export function ConfigProvider({ children }: { children: ReactNode }) {
  const config = useConfig();
  return <ConfigContext.Provider value={config}>{children}</ConfigContext.Provider>;
}

export function useConfigContext(): UseConfigResult {
  const ctx = useContext(ConfigContext);
  if (!ctx) {
    throw new Error("useConfigContext must be used within a ConfigProvider");
  }
  return ctx;
}
