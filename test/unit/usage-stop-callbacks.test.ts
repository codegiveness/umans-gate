import { expect, mock, test } from "bun:test";
import { UmansUsageClient } from "../../src/usage.js";

const baseConfig = {
  target: "https://api.code.umans.ai",
  umansApiKey: "sk-test-key",
  usageRefreshMs: 5000,
};

const validRawResponse = {
  user_id: "test-user-123",
  plan: { display_name: "Code Max", slug: "code_max" },
  limits: {
    requests: { limit: 200, hard_cap: 400, burst_pct: 1.0, window_seconds: 18000 },
    concurrency: { limit: 4, hard_cap: 8, burst_pct: 1.0 },
  },
  window: {
    started_at: "2026-07-16T04:51:53.756363+00:00",
    resets_at: "2026-07-16T09:51:53.756363+00:00",
    remaining_minutes: 206,
  },
  usage: {
    requests_in_window: 48,
    weighted_in_window: 24.0,
    remaining_requests: 152,
    weighted_remaining_requests: 76,
    concurrent_sessions: 1,
    weighted_concurrent_sessions: 0.5,
    tokens_in: 1200000,
    tokens_out: 340000,
    tokens_cached: 50000,
    priority: { low: false, boxed_until: null, reason: null },
    service_mode: { current: "interactive", resets_at: null },
  },
};

test("onChange callback does not fire after stop() on in-flight refresh", async () => {
  const originalFetch = globalThis.fetch;
  let resolveFetch: ((value: Response) => void) | null = null;
  const fetchPromise = new Promise<Response>((resolve) => {
    resolveFetch = resolve;
  });
  globalThis.fetch = mock(async () => fetchPromise) as unknown as typeof fetch;

  try {
    const client = new UmansUsageClient(baseConfig);
    let callCount = 0;
    client.onChange(() => {
      callCount++;
    });

    // Start refresh — it will hang on the unresolved fetch promise.
    const refreshPromise = client.refresh();

    // Stop the client while the fetch is still in-flight.
    client.stop();

    // Now resolve the fetch. applySnapshot will run, but the cleared
    // onChangeCbs array means our callback must NOT fire.
    resolveFetch!(new Response(JSON.stringify(validRawResponse), { status: 200 }));
    await refreshPromise;

    expect(callCount).toBe(0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
