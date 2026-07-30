import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePerformanceStats } from "@/hooks/use-performance-stats";
import type { PerformanceStatsRow } from "@/types";

function mockFetch(impl: (url: string) => Promise<unknown>) {
  const fn = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    return impl(url);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function jsonResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => body,
  };
}

function makeRow(
  model: string,
  provider: "anthropic" | "openai",
  requestCount: number,
): PerformanceStatsRow {
  return {
    model,
    provider,
    request_count: requestCount,
    streaming_count: 0,
    total_input_tokens: 0,
    total_output_tokens: 0,
    total_cache_read_tokens: 0,
    total_thinking_tokens: 0,
    requests_with_thinking: 0,
    cached_pct: 0,
    ttft_mean: null,
    ttft_max: null,
    ttft_p10: null,
    ttft_p50: null,
    ttft_p95: null,
    ttft_outlier_count: 0,
    tps_mean: null,
    tps_min: null,
    tps_p10: null,
    tps_p50: null,
    tps_p95: null,
    tps_outlier_count: 0,
  };
}

describe("usePerformanceStats", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("deduplicates rows with same model+provider keeping highest request_count", async () => {
    mockFetch(async () =>
      jsonResponse([
        makeRow("umans-flash", "openai", 13),
        makeRow("umans-flash", "openai", 16),
        makeRow("umans-flash", "openai", 14),
        makeRow("umans-glm-5.2", "anthropic", 121),
      ]),
    );

    const { result } = renderHook(() => usePerformanceStats());

    await waitFor(() => expect(result.current.stats).not.toBeNull());

    const stats = result.current.stats!;
    expect(stats).toHaveLength(2);
    const flash = stats.find((s) => s.model === "umans-flash")!;
    expect(flash.request_count).toBe(16);
  });

  it("sorts rows by model name then provider ascending", async () => {
    mockFetch(async () =>
      jsonResponse([
        makeRow("umans-glm-5.2", "anthropic", 10),
        makeRow("umans-flash", "openai", 5),
        makeRow("umans-coder", "anthropic", 3),
        makeRow("umans-flash", "anthropic", 2),
      ]),
    );

    const { result } = renderHook(() => usePerformanceStats());

    await waitFor(() => expect(result.current.stats).not.toBeNull());

    const stats = result.current.stats!;
    expect(stats.map((s) => `${s.model}/${s.provider}`)).toEqual([
      "umans-coder/anthropic",
      "umans-flash/anthropic",
      "umans-flash/openai",
      "umans-glm-5.2/anthropic",
    ]);
  });
});
