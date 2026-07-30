import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePollingResource } from "@/hooks/use-polling-resource";

interface TestData {
  value: number;
}

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

function setVisibilityState(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    get: () => state,
    configurable: true,
  });
  Object.defineProperty(document, "hidden", {
    get: () => state === "hidden",
    configurable: true,
  });
}

describe("usePollingResource visibility-aware polling", () => {
  let originalFetch: typeof globalThis.fetch;
  let originalHidden: PropertyDescriptor | undefined;
  let originalVisibilityState: PropertyDescriptor | undefined;
  let callCount = 0;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
    originalVisibilityState = Object.getOwnPropertyDescriptor(document, "visibilityState");
    callCount = 0;
    setVisibilityState("visible");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();

    if (originalHidden) {
      Object.defineProperty(document, "hidden", originalHidden);
    }
    if (originalVisibilityState) {
      Object.defineProperty(document, "visibilityState", originalVisibilityState);
    }
  });

  const parse = (value: unknown): TestData | null =>
    value === undefined ? null : (value as TestData);

  function useTestHook(pollInterval = 100) {
    return usePollingResource<TestData | null>({
      endpoint: "/test",
      pollInterval,
      errorMessage: "Failed to fetch",
      parse,
    });
  }

  it("fetches immediately on mount and on every poll interval", async () => {
    mockFetch(async () => {
      callCount++;
      return jsonResponse({ value: callCount });
    });

    renderHook(() => useTestHook());

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2), {
      timeout: 500,
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3), {
      timeout: 500,
    });
  });

  it("pauses polling when page becomes hidden", async () => {
    mockFetch(async () => {
      callCount++;
      return jsonResponse({ value: callCount });
    });

    renderHook(() => useTestHook());

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    act(() => {
      setVisibilityState("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches immediately and resumes interval when page becomes visible", async () => {
    mockFetch(async () => {
      callCount++;
      return jsonResponse({ value: callCount });
    });

    renderHook(() => useTestHook());

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    act(() => {
      setVisibilityState("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    act(() => {
      setVisibilityState("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2), {
      timeout: 500,
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3), {
      timeout: 500,
    });
  });

  it("keeps existing data and error null when a polling fetch fails after success", async () => {
    let shouldFail = false;
    mockFetch(async () => {
      if (shouldFail) throw new TypeError("Failed to fetch");
      return jsonResponse({ value: 42 });
    });

    const { result } = renderHook(() => useTestHook());

    await waitFor(() => expect(result.current.data).toEqual({ value: 42 }));
    expect(result.current.error).toBeNull();

    shouldFail = true;

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3), {
      timeout: 500,
    });

    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();
  });

  it("shows an error when the initial fetch fails", async () => {
    mockFetch(async () => {
      throw new TypeError("Failed to fetch");
    });

    const { result } = renderHook(() => useTestHook());

    await waitFor(() => expect(result.current.error).toBe("Failed to fetch"));
    expect(result.current.data).toBeNull();
  });

  it("keeps existing data when a later fetch returns non-JSON", async () => {
    let returnHtml = false;
    mockFetch(async () => {
      if (returnHtml) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "text/html" },
          json: async () => ({ value: 99 }),
        };
      }
      return jsonResponse({ value: 42 });
    });

    const { result } = renderHook(() => useTestHook());

    await waitFor(() => expect(result.current.data).toEqual({ value: 42 }));

    returnHtml = true;

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3), {
      timeout: 500,
    });

    expect(result.current.data).toEqual({ value: 42 });
    expect(result.current.error).toBeNull();
  });

  it("clears error immediately when refresh is called", async () => {
    let shouldFail = true;
    mockFetch(async () => {
      if (shouldFail) throw new TypeError("Failed to fetch");
      return jsonResponse({ value: 42 });
    });

    const { result } = renderHook(() => useTestHook());

    await waitFor(() => expect(result.current.error).toBe("Failed to fetch"));

    shouldFail = false;

    act(() => {
      result.current.refresh();
    });

    expect(result.current.error).toBeNull();
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.data).toEqual({ value: 42 }));
  });

  it("removes the listener and stops the interval on unmount", async () => {
    const removeListener = vi.spyOn(document, "removeEventListener");
    mockFetch(async () => jsonResponse({ value: 1 }));

    const { unmount } = renderHook(() => useTestHook());

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    act(() => unmount());

    expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
  });

  it("does not restart polling when parse identity changes between renders", async () => {
    mockFetch(async () => jsonResponse({ value: 1 }));

    const { rerender } = renderHook(
      ({ parse }: { parse: (value: unknown) => TestData | null }) =>
        usePollingResource<TestData | null>({
          endpoint: "/test",
          pollInterval: 200,
          errorMessage: "Failed to fetch",
          parse,
        }),
      {
        initialProps: {
          parse: (value: unknown): TestData | null =>
            value === undefined ? null : (value as TestData),
        },
      },
    );

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    act(() => {
      rerender({
        parse: (value: unknown): TestData | null =>
          value === undefined ? null : (value as TestData),
      });
    });

    // Immediately after the rerender, no extra fetch should have been triggered.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    // The next fetch should come from the original poll interval, not from an effect restart.
    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2), {
      timeout: 500,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("polling continues with a live signal after refresh() aborts the previous controller", async () => {
    mockFetch(async () => {
      callCount++;
      return jsonResponse({ value: callCount });
    });

    const { result } = renderHook(() => useTestHook(100));

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(1));

    act(() => {
      result.current.refresh();
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2), {
      timeout: 500,
    });

    await waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(3), {
      timeout: 500,
    });
  });
});
