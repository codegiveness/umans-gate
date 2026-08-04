import type { WalletTier } from "../types.js";

export interface WalletTierInput {
  requestsLimit: number | null; // raw limits.requests.limit
  windowSeconds: number | null; // raw limits.requests.window_seconds
  concurrencyLimit: number | null; // raw limits.concurrency.limit
}

interface WalletRow {
  tier: number;
  requestsLimit: number;
  windowSeconds?: number;
  concurrencyLimit?: number;
}

const WALLET_TABLE: WalletRow[] = [
  { tier: 0, requestsLimit: 500, windowSeconds: 18000, concurrencyLimit: 4 },
  { tier: 1, requestsLimit: 1000, concurrencyLimit: 8 },
  { tier: 2, requestsLimit: 2000, concurrencyLimit: 12 },
  { tier: 3, requestsLimit: 4000, concurrencyLimit: 16 },
];

export function deriveWalletTier(input: WalletTierInput): WalletTier {
  if (input.requestsLimit === null) return "unknown";
  const row = WALLET_TABLE.find((r) => r.requestsLimit === input.requestsLimit);
  if (!row) return "unknown"; // never snap to nearest tier
  // optional contradiction guard: only if a window is known AND the row specifies one AND they differ
  if (
    input.windowSeconds != null &&
    row.windowSeconds !== undefined &&
    input.windowSeconds !== row.windowSeconds
  ) {
    return "unknown";
  }
  return row.tier as Exclude<WalletTier, "unknown" | "unlimited">;
}
