import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VersionInfo } from "@/hooks/use-version";
import { useVersion } from "@/hooks/use-version";
import { VERSION_API_BASE, VERSION_EVENT } from "@/lib/constants";

const initialVersion: VersionInfo = {
  current: "0.3.14",
  latest: "0.3.14",
  updateAvailable: false,
  lastCheckedAt: 1700000000000,
  error: null,
  releaseNotes: null,
  canUpdate: false,
  canUpdateReason: "no_service",
};

const pushedVersion: VersionInfo = {
  current: "0.3.14",
  latest: "0.3.15",
  updateAvailable: true,
  lastCheckedAt: 1700000060000,
  error: null,
  releaseNotes: "## What's Changed\n\n- Bug fixes",
  canUpdate: false,
  canUpdateReason: "no_service",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (url.includes(VERSION_API_BASE) && !url.includes("/check") && method === "GET") {
      return new Response(JSON.stringify(initialVersion), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useVersion WS push", () => {
  it("updates version state when a VERSION_EVENT is dispatched", async () => {
    const { result } = renderHook(() => useVersion());

    await waitFor(() => expect(result.current.version).toEqual(initialVersion));

    act(() => {
      window.dispatchEvent(new CustomEvent(VERSION_EVENT, { detail: pushedVersion }));
    });

    await waitFor(() => expect(result.current.version).toEqual(pushedVersion));
  });

  it("does not call fetch when the WS push arrives", async () => {
    const { result } = renderHook(() => useVersion());

    await waitFor(() => expect(result.current.version).toEqual(initialVersion));

    const fetchCountBefore = fetchMock.mock.calls.length;

    act(() => {
      window.dispatchEvent(new CustomEvent(VERSION_EVENT, { detail: pushedVersion }));
    });

    await waitFor(() => expect(result.current.version).toEqual(pushedVersion));
    expect(fetchMock.mock.calls.length).toBe(fetchCountBefore);
  });

  it("ignores unrelated custom events", async () => {
    const { result } = renderHook(() => useVersion());

    await waitFor(() => expect(result.current.version).toEqual(initialVersion));

    act(() => {
      window.dispatchEvent(new CustomEvent("umans-gate:capture-done"));
      window.dispatchEvent(new CustomEvent("umans-gate:usage-sample"));
    });

    expect(result.current.version).toEqual(initialVersion);
  });

  it("removes the listener on unmount", async () => {
    const { result, unmount } = renderHook(() => useVersion());

    await waitFor(() => expect(result.current.version).toEqual(initialVersion));

    unmount();

    act(() => {
      window.dispatchEvent(new CustomEvent(VERSION_EVENT, { detail: pushedVersion }));
    });

    expect(result.current.version).toEqual(initialVersion);
  });
});
