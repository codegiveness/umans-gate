import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useCaptures } from "@/hooks/use-captures";
import type { CaptureSummary } from "@/types";

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

function makeCapture(overrides: Partial<CaptureSummary> = {}): CaptureSummary {
  return {
    id: 1,
    method: "POST",
    path: "/v1/messages",
    response_status: null,
    is_sse: false,
    content_type: null,
    request_size: 1024,
    response_size: 2048,
    duration_ms: 150,
    state: "streaming",
    started_at: 1735732800,
    finished_at: null,
    incoming_protocol: "http1.1",
    upstream_protocol: "http2",
    model: "claude-3",
    usage_missing: false,
    ttft_ms: null,
    tps: null,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_input_tokens: 100,
    output_tokens: 200,
    total_output_tokens: 200,
    is_vision: false,
    status_source: null,
    gate_reason: null,
    retry_attempt: null,
    ttft_exceeded: null,
    upstream_ttft_p50_ms: null,
    upstream_tps_p50: null,
    ...overrides,
  };
}

describe("useCaptures WS state + update handlers", () => {
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

  function mockFetch() {
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/captures")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => [],
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => "application/json" },
        json: async () => ({ active: 0, hardCap: 16, softLimit: 8 }),
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  async function setupSocket() {
    mockFetch();
    const { result } = renderHook(() => useCaptures());

    await waitFor(() => {
      expect(result.current.captures).toEqual([]);
    });
    await waitFor(() => {
      expect(MockWebSocket.instances.length).toBeGreaterThan(0);
    });

    const ws = MockWebSocket.instances[0];
    ws.onopen?.();
    return { result, ws };
  }

  it("state message with responseStatus patches response_status", async () => {
    const { result, ws } = await setupSocket();

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "new", capture: makeCapture({ id: 1 }) }),
      } as MessageEvent);
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "state",
          captureId: 1,
          state: "streaming",
          responseStatus: 200,
          statusSource: "upstream",
        }),
      } as MessageEvent);
    });

    expect(result.current.captures[0].response_status).toBe(200);
    expect(result.current.captures[0].status_source).toBe("upstream");
  });

  it("state message without responseStatus preserves existing response_status", async () => {
    const { result, ws } = await setupSocket();

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "new", capture: makeCapture({ id: 1 }) }),
      } as MessageEvent);
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "state",
          captureId: 1,
          state: "streaming",
          responseStatus: 200,
          statusSource: "upstream",
        }),
      } as MessageEvent);
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "state",
          captureId: 1,
          state: "cooling_down",
        }),
      } as MessageEvent);
    });

    expect(result.current.captures[0].response_status).toBe(200);
    expect(result.current.captures[0].status_source).toBe("upstream");
  });

  it("update message with response_status: null (first-chunk) preserves prior status via merge", async () => {
    const { result, ws } = await setupSocket();

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "new", capture: makeCapture({ id: 1 }) }),
      } as MessageEvent);
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "state",
          captureId: 1,
          state: "streaming",
          responseStatus: 200,
          statusSource: "upstream",
        }),
      } as MessageEvent);
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "update",
          capture: makeCapture({
            id: 1,
            state: "streaming",
            response_status: null,
            ttft_ms: 500,
          }),
        }),
      } as MessageEvent);
    });

    expect(result.current.captures[0].response_status).toBe(200);
    expect(result.current.captures[0].ttft_ms).toBe(500);
  });

  it("update message with response_status: 200 (done) replaces with correct value", async () => {
    const { result, ws } = await setupSocket();

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({ type: "new", capture: makeCapture({ id: 1 }) }),
      } as MessageEvent);
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "state",
          captureId: 1,
          state: "streaming",
          responseStatus: 429,
          statusSource: "upstream",
        }),
      } as MessageEvent);
    });

    act(() => {
      ws.onmessage?.({
        data: JSON.stringify({
          type: "update",
          capture: makeCapture({
            id: 1,
            state: "done",
            response_status: 200,
            status_source: "upstream",
          }),
        }),
      } as MessageEvent);
    });

    expect(result.current.captures[0].response_status).toBe(200);
    expect(result.current.captures[0].state).toBe("done");
  });

  // Regression: model, upstream_ttft_p50_ms, upstream_tps_p50 must NOT be
  // overwritten to null when an update message (e.g. the TTFT first-chunk
  // broadcast or the p50 detached-fetch broadcast) carries null for these
  // fields. The merge must preserve early-patched non-null values, the same
  // way response_status and status_source are already guarded.
  describe("null-overwrite guard for model + upstream p50 fields", () => {
    it("preserves model when TTFT update carries model: null", async () => {
      const { result, ws } = await setupSocket();

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "new",
            capture: makeCapture({ id: 1, model: "umans-glm-4.6" }),
          }),
        } as MessageEvent);
      });

      // p50 detached-fetch update: DB row has model=null, brings p50 data
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "update",
            capture: makeCapture({
              id: 1,
              model: null,
              upstream_ttft_p50_ms: 2400,
              upstream_tps_p50: 50.6,
            }),
          }),
        } as MessageEvent);
      });

      expect(result.current.captures[0].model).toBe("umans-glm-4.6");
      expect(result.current.captures[0].upstream_ttft_p50_ms).toBe(2400);
      expect(result.current.captures[0].upstream_tps_p50).toBe(50.6);
    });

    it("preserves upstream_ttft_p50_ms + upstream_tps_p50 when TTFT update nulls them", async () => {
      const { result, ws } = await setupSocket();

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "new",
            capture: makeCapture({ id: 1, model: "umans-glm-4.6" }),
          }),
        } as MessageEvent);
      });

      // p50 arrives via detached-fetch update
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "update",
            capture: makeCapture({
              id: 1,
              model: null,
              upstream_ttft_p50_ms: 2400,
              upstream_tps_p50: 50.6,
            }),
          }),
        } as MessageEvent);
      });

      // TTFT first-chunk update: newSummary() hardcodes these to null
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "update",
            capture: makeCapture({
              id: 1,
              state: "streaming",
              model: "umans-glm-4.6",
              ttft_ms: 500,
              upstream_ttft_p50_ms: null,
              upstream_tps_p50: null,
            }),
          }),
        } as MessageEvent);
      });

      expect(result.current.captures[0].model).toBe("umans-glm-4.6");
      expect(result.current.captures[0].ttft_ms).toBe(500);
      expect(result.current.captures[0].upstream_ttft_p50_ms).toBe(2400);
      expect(result.current.captures[0].upstream_tps_p50).toBe(50.6);
    });

    it("done update with non-null model replaces the early value", async () => {
      const { result, ws } = await setupSocket();

      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "new",
            capture: makeCapture({ id: 1, model: "umans-glm-4.6" }),
          }),
        } as MessageEvent);
      });

      // Done: buildSummary extracts model from response body — replaces
      act(() => {
        ws.onmessage?.({
          data: JSON.stringify({
            type: "update",
            capture: makeCapture({
              id: 1,
              state: "done",
              model: "umans-glm-4.6-20260730",
            }),
          }),
        } as MessageEvent);
      });

      expect(result.current.captures[0].model).toBe("umans-glm-4.6-20260730");
    });
  });
});
