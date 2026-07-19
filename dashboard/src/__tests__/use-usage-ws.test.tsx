import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUsageWs } from "@/hooks/use-usage-ws";
import {
  USAGE_EVENT_EVENT,
  USAGE_SAMPLE_EVENT,
  type UsageEventWsDetail,
  type UsageSampleWsDetail,
} from "@/lib/constants";

describe("useUsageWs", () => {
  let sampleCalls: UsageSampleWsDetail[];
  let eventCalls: UsageEventWsDetail[];
  let onSample: (d: UsageSampleWsDetail) => void;
  let onEvent: (d: UsageEventWsDetail) => void;

  beforeEach(() => {
    sampleCalls = [];
    eventCalls = [];
    onSample = (d) => {
      sampleCalls.push(d);
    };
    onEvent = (d) => {
      eventCalls.push(d);
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls onSample when a usage-sample window event is dispatched", () => {
    renderHook(() => useUsageWs({ onSample, onEvent }));

    const detail: UsageSampleWsDetail = {
      dayUtc: "2026-07-19",
      fetchedAt: 1721376000000,
    };

    act(() => {
      window.dispatchEvent(new CustomEvent(USAGE_SAMPLE_EVENT, { detail }));
    });

    expect(sampleCalls).toEqual([detail]);
    expect(eventCalls).toEqual([]);
  });

  it("calls onEvent when a usage-event window event is dispatched", () => {
    renderHook(() => useUsageWs({ onSample, onEvent }));

    const detail: UsageEventWsDetail = {
      dayUtc: "2026-07-19",
      tupleKind: "priority",
      transition: "onset",
      fetchedAt: 1721376000000,
    };

    act(() => {
      window.dispatchEvent(new CustomEvent(USAGE_EVENT_EVENT, { detail }));
    });

    expect(eventCalls).toEqual([detail]);
    expect(sampleCalls).toEqual([]);
  });

  it("ignores events for other custom event names", () => {
    renderHook(() => useUsageWs({ onSample, onEvent }));

    act(() => {
      window.dispatchEvent(new CustomEvent("umans-gate:capture-done"));
    });

    expect(sampleCalls).toEqual([]);
    expect(eventCalls).toEqual([]);
  });

  it("removes listeners on unmount", () => {
    const { unmount } = renderHook(() => useUsageWs({ onSample, onEvent }));

    unmount();

    act(() => {
      window.dispatchEvent(
        new CustomEvent(USAGE_SAMPLE_EVENT, {
          detail: { dayUtc: "2026-07-19", fetchedAt: 0 },
        }),
      );
    });

    expect(sampleCalls).toEqual([]);
  });

  it("uses the latest callback without re-subscribing", () => {
    const callsA: UsageSampleWsDetail[] = [];
    const callsB: UsageSampleWsDetail[] = [];
    const onSampleA = (d: UsageSampleWsDetail) => {
      callsA.push(d);
    };
    const onSampleB = (d: UsageSampleWsDetail) => {
      callsB.push(d);
    };

    const { rerender } = renderHook(
      ({ cb }: { cb: (d: UsageSampleWsDetail) => void }) => useUsageWs({ onSample: cb, onEvent }),
      { initialProps: { cb: onSampleA } },
    );

    rerender({ cb: onSampleB });

    act(() => {
      window.dispatchEvent(
        new CustomEvent(USAGE_SAMPLE_EVENT, {
          detail: { dayUtc: "2026-07-19", fetchedAt: 0 },
        }),
      );
    });

    expect(callsA).toEqual([]);
    expect(callsB).toEqual([{ dayUtc: "2026-07-19", fetchedAt: 0 }]);
  });
});
