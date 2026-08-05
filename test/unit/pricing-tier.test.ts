import { describe, expect, it } from "bun:test";
import type { WalletTier } from "../../src/types.js";
import { WALLET_TIERS, type WalletTierRow } from "../../src/usage/limits-schema.js";
import type { WalletTierInput } from "../../src/usage/pricing-tier.js";
import { deriveWalletTier } from "../../src/usage/pricing-tier.js";

describe("deriveWalletTier", () => {
  it("returns unknown when requestsLimit is null", () => {
    const input: WalletTierInput = {
      requestsLimit: null,
      windowSeconds: null,
      concurrencyLimit: null,
    };
    expect(deriveWalletTier(input)).toBe("unknown");
  });

  it("exact-matches each table requests.limit to its tier", () => {
    const cases: Array<{ limit: number; expected: Exclude<WalletTier, "unknown"> }> = [
      { limit: 500, expected: 0 },
      { limit: 1000, expected: 1 },
      { limit: 2000, expected: 2 },
      { limit: 4000, expected: 3 },
    ];
    for (const { limit, expected } of cases) {
      expect(
        deriveWalletTier({ requestsLimit: limit, windowSeconds: null, concurrencyLimit: null }),
      ).toBe(expected);
    }
  });

  it("factors: every WALLET_TIERS row derives to its own tier", () => {
    for (const row of WALLET_TIERS as readonly WalletTierRow[]) {
      expect(
        deriveWalletTier({
          requestsLimit: row.requestsLimit,
          windowSeconds: row.windowSeconds ?? null,
          concurrencyLimit: null,
        }),
      ).toBe(row.tier);
    }
  });

  it("returns unknown for off-table requests.limit values (never nearest-snaps)", () => {
    const offTable: Array<number | null> = [0, 1500, 3000, 9999, 7.5, -1];
    for (const limit of offTable) {
      expect(
        deriveWalletTier({ requestsLimit: limit, windowSeconds: null, concurrencyLimit: null }),
      ).toBe("unknown");
    }
  });

  it("regression: ignores window_seconds - a 500-limit wallet stays tier 0 (was: unknown)", () => {
    // /v1/usage declares the tier via limits.requests.limit ONLY per
    // https://app.umans.ai/offers/code/docs#limits. Upstream returns
    // window_seconds inconsistently (e.g. 3600, 1020), which used to flip a
    // 500-limit T0 wallet to "unknown" despite the limit being authoritative.
    for (const windowSeconds of [3600, 1020, 18000]) {
      const input: WalletTierInput = {
        requestsLimit: 500,
        windowSeconds,
        concurrencyLimit: null,
      };
      expect(deriveWalletTier(input)).toBe(0);
    }
  });

  it("tiers when window matches the row window", () => {
    const input: WalletTierInput = {
      requestsLimit: 500,
      windowSeconds: 18000,
      concurrencyLimit: null,
    };
    expect(deriveWalletTier(input)).toBe(0);
  });

  it("tiers when window is null", () => {
    const input: WalletTierInput = {
      requestsLimit: 500,
      windowSeconds: null,
      concurrencyLimit: null,
    };
    expect(deriveWalletTier(input)).toBe(0);
  });

  it("never demotes by concurrency (advisory only)", () => {
    const input: WalletTierInput = {
      requestsLimit: 1000,
      windowSeconds: null,
      concurrencyLimit: 16,
    };
    expect(deriveWalletTier(input)).toBe(1);
  });

  // Regression guard, deliberately locked at "unknown":
  // The wallet table carries only numeric tiers (T0-T3); deriveWalletTier
  // never returns an unlimited value. A null requestsLimit means no limit was
  // observed, hence unknown.
  it("regression guard: never returns unlimited from this fn", () => {
    const input: WalletTierInput = {
      requestsLimit: null,
      windowSeconds: null,
      concurrencyLimit: null,
    };
    expect(deriveWalletTier(input)).toBe("unknown");
  });

  it("skips window guard when row has no window constraint (T1)", () => {
    const input: WalletTierInput = {
      requestsLimit: 1000,
      windowSeconds: 9999,
      concurrencyLimit: null,
    };
    expect(deriveWalletTier(input)).toBe(1);
  });
});
