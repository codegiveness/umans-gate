// Central wallet-tier limits schema. Source: https://app.umans.ai/offers/code/docs#limits
// /v1/usage never returns a wallet tier; subscription plans are deprecated, so every
// key is a wallet/pay-by-token key. `hard_cap` is the burst ceiling; the rolling
// window rolls rather than resetting.

export type WalletTierIndex = 0 | 1 | 2 | 3;

export interface WalletTierRow {
  tier: WalletTierIndex;
  requestsLimit: number;
  concurrencyLimit: number;
  windowSeconds?: number;
}

export const WALLET_TIERS = [
  { tier: 0, requestsLimit: 500, windowSeconds: 18000, concurrencyLimit: 4 },
  { tier: 1, requestsLimit: 1000, windowSeconds: 18000, concurrencyLimit: 8 },
  { tier: 2, requestsLimit: 2000, windowSeconds: 18000, concurrencyLimit: 12 },
  { tier: 3, requestsLimit: 4000, windowSeconds: 18000, concurrencyLimit: 16 },
] as const satisfies readonly WalletTierRow[];

export const LIMITS_SCHEMA = {
  limits: {
    requests: ["limit", "hard_cap", "burst_pct", "window_seconds"] as const,
    concurrency: ["limit", "hard_cap"] as const,
  },
  usage: [
    "requests_in_window",
    "remaining_requests",
    "concurrent_sessions",
    "tokens_in",
    "tokens_out",
  ] as const,
  priority: ["low", "boxed_until", "reason"] as const,
  service_mode: ["current", "resets_at"] as const,
} as const;
