import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCaptures } from "@/hooks/use-captures";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readyState = 0;
  constructor() {
    MockWebSocket.instances.push(this);
  }
  close() {
    this.onclose?.();
  }
  send() {}
}

describe("useCaptures error surfacing", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalWebSocket: typeof globalThis.WebSocket;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalWebSocket = globalThis.WebSocket;
    MockWebSocket.instances = [];
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
    vi.restoreAllMocks();
  });

  function mockFetch(impl: (url: string) => Promise<unknown>) {
    const fn = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      return impl(url);
    });
    globalThis.fetch = fn as unknown as typeof fetch;
    return fn;
  }

  it("surfaces listError when initial loadList fetch rejects", async () => {
    mockFetch(async () => {
      throw new Error("network down");
    });

    const { result } = renderHook(() => useCaptures());

    await waitFor(() => {
      expect(result.current.listError).not.toBeNull();
    });
    expect(result.current.listError).toContain("network down");
  });

  it("surfaces listError when initial loadList returns non-ok HTTP", async () => {
    mockFetch(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
      json: async () => [],
    }));

    const { result } = renderHook(() => useCaptures());

    await waitFor(() => {
      expect(result.current.listError).not.toBeNull();
    });
    expect(result.current.listError).toContain("500");
  });

  it("surfaces detailError when fetchCapture rejects", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount <= 2) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => [],
        };
      }
      throw new Error("detail fetch failed");
    });

    const { result } = renderHook(() => useCaptures());

    await waitFor(() => {
      expect(result.current.captures).toEqual([]);
    });

    act(() => {
      result.current.selectCapture(42);
    });

    await waitFor(() => {
      expect(result.current.detailError).not.toBeNull();
    });
    expect(result.current.detailError).toContain("detail fetch failed");
  });

  it("surfaces gateError when loadGate fetch rejects", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => [],
        };
      }
      throw new Error("gate unavailable");
    });

    const { result } = renderHook(() => useCaptures());

    await waitFor(() => {
      expect(result.current.gateError).not.toBeNull();
    });
    expect(result.current.gateError).toContain("gate unavailable");
  });

  it("clears listError on successful retry", async () => {
    let callCount = 0;
    mockFetch(async () => {
      callCount++;
      if (callCount === 1) {
        throw new Error("first fail");
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => [],
      };
    });

    const { result } = renderHook(() => useCaptures());

    await waitFor(() => {
      expect(result.current.listError).not.toBeNull();
    });

    act(() => {
      result.current.retryList();
    });

    await waitFor(() => {
      expect(result.current.listError).toBeNull();
    });
  });
});
