import type { WalletTier } from "../types.js";
import { WALLET_TIERS, type WalletTierRow } from "./limits-schema.js";

export interface WalletTierInput {
  requestsLimit: number | null; // raw limits.requests.limit
  windowSeconds: number | null; // raw limits.requests.window_seconds
  concurrencyLimit: number | null; // raw limits.concurrency.limit
}

export function deriveWalletTier(input: WalletTierInput): WalletTier {
  if (input.requestsLimit === null) return "unknown";
  const row: WalletTierRow | undefined = WALLET_TIERS.find(
    (r) => r.requestsLimit === input.requestsLimit,
  );
  if (!row) return "unknown"; // never snap to nearest tier
  // Tier is identified by requestsLimit ONLY per https://app.umans.ai/offers/code/docs#limits.
  // window_seconds is advisory and must NOT disqualify a matching limit: upstream returns
  // it inconsistently, and every tier shares the same rolling window.
  return row.tier;
}
