import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { App } from "@/App";
import { flushEffects } from "@/test/utils";

const ROW_HEIGHT = 76;

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => ROW_HEIGHT * count,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, i) => ({
        index: i,
        start: i * ROW_HEIGHT,
        size: ROW_HEIGHT,
        key: i,
      })),
    measureElement: () => {},
    scrollToIndex: () => {},
    scrollToOffset: () => {},
  }),
}));

const mockSelectCapture = vi.fn();

vi.mock("@/hooks/use-captures", () => ({
  useCaptures: () => ({
    captures: [
      {
        id: 1,
        method: "POST",
        path: "/v1/messages",
        response_status: 200,
        state: "done",
        is_sse: false,
        request_size: 1024,
        response_size: 2048,
        duration_ms: 150,
        started_at: Date.parse("2026-01-01T00:00:00Z"),
        ttft_ms: 50,
        tps: 10,
        total_input_tokens: 100,
        total_output_tokens: 200,
        cache_read_tokens: 0,
        incoming_protocol: "http1.1",
        upstream_protocol: "http2",
      },
    ],
    selectedCapture: null,
    isLoadingDetail: false,
    isLoadingList: false,
    wsState: "live" as const,
    selectedId: null,
    gateStats: null,
    listError: null,
    gateError: null,
    detailError: null,
    selectCapture: mockSelectCapture,
    clearCaptures: vi.fn(),
    retryList: () => {},
    retryGate: () => {},
    retryDetail: () => {},
  }),
}));

vi.mock("@/hooks/use-clipboard", () => ({
  useClipboard: () => ({
    copyText: () => Promise.resolve(true),
  }),
}));

vi.mock("@/components/mode-toggle", () => ({
  ModeToggle: () => null,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

describe("MasterDetailLayout responsive shell", () => {
  it("renders the hamburger button with md:hidden and aria-label", async () => {
    render(<App />);
    await flushEffects();
    const hamburger = screen.getByRole("button", { name: "Open captures" });
    expect(hamburger).toBeInTheDocument();
    expect(hamburger).toHaveClass("md:hidden");
  });

  it("renders the master sidebar at desktop width (aside with aria-label)", async () => {
    render(<App />);
    await flushEffects();
    const master = screen.getByLabelText("Captures list");
    expect(master.tagName).toBe("ASIDE");
    expect(master).toHaveClass("hidden", "md:flex");
  });

  it("renders the detail panel with aria-label", async () => {
    render(<App />);
    await flushEffects();
    const detail = screen.getByLabelText("Capture detail");
    expect(detail).toBeInTheDocument();
  });

  it("opens the drawer on hamburger click and closes on capture selection", async () => {
    const user = userEvent.setup();

    render(<App />);
    await flushEffects();

    const hamburger = screen.getByRole("button", { name: "Open captures" });
    await user.click(hamburger);

    const dialog = await screen.findByRole("dialog", { name: "Captures list" });
    expect(dialog).toBeInTheDocument();

    const captureRow = within(dialog).getByText("/v1/messages");
    await user.click(captureRow);

    expect(mockSelectCapture).toHaveBeenCalledWith(1);

    expect(screen.queryByRole("dialog", { name: "Captures list" })).not.toBeInTheDocument();
  });
});
