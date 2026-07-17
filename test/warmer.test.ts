// Test: ConnectionWarmer response body consumption (W1 — TLS connection leak).
// Verifies that ping() always consumes the response body so the underlying
// TLS connection is returned to the keep-alive pool, and that body
// consumption failures do not surface as unhandled promise rejections.

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ProxyConfig, UpstreamProtocol } from "../src/types.js";
import { ConnectionWarmer } from "../src/warmer.js";

type FetchImpl = typeof fetch;

function makeConfig(
  overrides?: Partial<ProxyConfig>,
): Pick<ProxyConfig, "target" | "warmerIntervalMs" | "warmerPath" | "upstreamProtocol"> {
  return {
    target: "https://upstream.test",
    warmerIntervalMs: 1000,
    warmerPath: "/v1/models",
    upstreamProtocol: "http2" as UpstreamProtocol,
    ...overrides,
  };
}

/** Minimal fake Response that records body consumption. */
function makeResponse(opts: {
  ok: boolean;
  status?: number;
  bodyText?: string;
  textThrows?: boolean;
  consumedRef: { value: boolean };
}): Response {
  const { ok, status = ok ? 200 : 500, bodyText = "ok", textThrows = false, consumedRef } = opts;
  const res = {
    ok,
    status,
    body: null,
    async text() {
      if (textThrows) throw new Error("body read failed");
      consumedRef.value = true;
      return bodyText;
    },
  } as unknown as Response;
  return res;
}

describe("ConnectionWarmer ping() body consumption", () => {
  let originalFetch: FetchImpl;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("consumes response body on successful ping", async () => {
    const consumed = { value: false };
    globalThis.fetch = mock(async () =>
      makeResponse({ ok: true, status: 200, consumedRef: consumed }),
    ) as unknown as FetchImpl;

    const warmer = new ConnectionWarmer(makeConfig());
    // Access private ping via a cast — ping is internal, but we are testing
    // the contract that the body is consumed.
    await (warmer as unknown as { ping: () => Promise<void> }).ping();

    expect(consumed.value).toBe(true);
  });

  test("consumes response body on non-OK (e.g. 500) ping", async () => {
    const consumed = { value: false };
    globalThis.fetch = mock(async () =>
      makeResponse({ ok: false, status: 500, consumedRef: consumed }),
    ) as unknown as FetchImpl;

    const warmer = new ConnectionWarmer(makeConfig());
    await (warmer as unknown as { ping: () => Promise<void> }).ping();

    expect(consumed.value).toBe(true);
  });

  test("does not throw unhandled rejection when body consumption fails", async () => {
    globalThis.fetch = mock(async () =>
      makeResponse({ ok: true, status: 200, textThrows: true, consumedRef: { value: false } }),
    ) as unknown as FetchImpl;

    const warmer = new ConnectionWarmer(makeConfig());
    // Must not throw — body consumption failure must be swallowed (best-effort).
    await expect(
      (warmer as unknown as { ping: () => Promise<void> }).ping(),
    ).resolves.toBeUndefined();
  });

  test("skips ping when recent traffic occurred", async () => {
    let fetchCalled = false;
    globalThis.fetch = mock(async () => {
      fetchCalled = true;
      return makeResponse({ ok: true, consumedRef: { value: false } });
    }) as unknown as FetchImpl;

    const warmer = new ConnectionWarmer(makeConfig({ warmerIntervalMs: 60_000 }));
    warmer.notifyTraffic(); // mark recent traffic
    await (warmer as unknown as { ping: () => Promise<void> }).ping();

    expect(fetchCalled).toBe(false);
  });
});
