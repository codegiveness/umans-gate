import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CaptureList } from "@/components/capture-list";
import { flushEffects } from "@/test/utils";
import type { CaptureSummary } from "@/types";

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

vi.mock("@/components/layout/master-detail-layout", () => ({
  useMasterDetail: () => ({ isOpen: false, closeDrawer: vi.fn() }),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function makeCapture(overrides: Partial<CaptureSummary> = {}): CaptureSummary {
  return {
    id: 1,
    method: "POST",
    path: "/v1/messages",
    response_status: 200,
    is_sse: false,
    content_type: null,
    request_size: 1024,
    response_size: 2048,
    duration_ms: 150,
    state: "done",
    started_at: 1735732800,
    finished_at: 1735732950,
    incoming_protocol: "http1.1",
    upstream_protocol: "http2",
    model: "claude-3",
    usage_missing: false,
    ttft_ms: 50,
    tps: 10,
    cache_creation_tokens: 0,
    cache_read_tokens: 0,
    total_input_tokens: 100,
    output_tokens: 200,
    total_output_tokens: 200,
    is_vision: false,
    status_source: null,
    gate_reason: null,
    ...overrides,
  };
}

const baseProps = {
  wsState: "live" as const,
  gateStats: null,
  listError: null as string | null,
  isLoading: false,
  onClear: vi.fn(),
  onRetry: vi.fn(),
};

describe("CaptureList listbox keyboard navigation", () => {
  it("renders a listbox with aria-label and options", async () => {
    const captures = [
      makeCapture({ id: 1, path: "/v1/messages" }),
      makeCapture({ id: 2, path: "/v1/chat/completions" }),
      makeCapture({ id: 3, path: "/v1/embeddings" }),
    ];

    render(<CaptureList captures={captures} selectedId={null} onSelect={vi.fn()} {...baseProps} />);
    await flushEffects();

    const listbox = screen.getByRole("listbox", { name: "Captures" });
    expect(listbox).toBeInTheDocument();
    expect(listbox).toHaveAttribute("tabindex", "0");

    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(3);
    expect(options[0]).toHaveAttribute("id", "capture-opt-1");
    expect(options[0]).toHaveAttribute("aria-selected", "false");
  });

  it("moves active descendant on ArrowDown/ArrowUp", async () => {
    const user = userEvent.setup();
    const captures = [
      makeCapture({ id: 1, path: "/v1/messages" }),
      makeCapture({ id: 2, path: "/v1/chat" }),
      makeCapture({ id: 3, path: "/v1/embed" }),
    ];

    render(<CaptureList captures={captures} selectedId={null} onSelect={vi.fn()} {...baseProps} />);
    await flushEffects();

    const listbox = screen.getByRole("listbox");
    listbox.focus();

    // Initial: activeIndex 0 -> capture-opt-1
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-1");

    await user.keyboard("{ArrowDown}");
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-2");

    await user.keyboard("{ArrowDown}");
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-3");

    // Clamp at last
    await user.keyboard("{ArrowDown}");
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-3");

    await user.keyboard("{ArrowUp}");
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-2");

    // Clamp at first
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{ArrowUp}");
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-1");
  });

  it("jumps to first/last on Home/End", async () => {
    const user = userEvent.setup();
    const captures = [
      makeCapture({ id: 10, path: "/a" }),
      makeCapture({ id: 20, path: "/b" }),
      makeCapture({ id: 30, path: "/c" }),
      makeCapture({ id: 40, path: "/d" }),
    ];

    render(<CaptureList captures={captures} selectedId={null} onSelect={vi.fn()} {...baseProps} />);
    await flushEffects();

    const listbox = screen.getByRole("listbox");
    listbox.focus();

    await user.keyboard("{End}");
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-40");

    await user.keyboard("{Home}");
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-10");
  });

  it("selects the active row on Enter", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const captures = [
      makeCapture({ id: 1, path: "/v1/messages" }),
      makeCapture({ id: 2, path: "/v1/chat" }),
      makeCapture({ id: 3, path: "/v1/embed" }),
    ];

    render(
      <CaptureList captures={captures} selectedId={null} onSelect={onSelect} {...baseProps} />,
    );
    await flushEffects();

    const listbox = screen.getByRole("listbox");
    listbox.focus();

    await user.keyboard("{ArrowDown}");
    await user.keyboard("{Enter}");

    expect(onSelect).toHaveBeenCalledWith(2);
  });

  it("selects the active row on Space", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const captures = [
      makeCapture({ id: 5, path: "/v1/messages" }),
      makeCapture({ id: 6, path: "/v1/chat" }),
    ];

    render(
      <CaptureList captures={captures} selectedId={null} onSelect={onSelect} {...baseProps} />,
    );
    await flushEffects();

    const listbox = screen.getByRole("listbox");
    listbox.focus();

    await user.keyboard("{ArrowDown}");
    await user.keyboard(" ");

    expect(onSelect).toHaveBeenCalledWith(6);
  });

  it("clicking a row selects it and syncs activeIndex", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const captures = [
      makeCapture({ id: 1, path: "/v1/messages" }),
      makeCapture({ id: 2, path: "/v1/chat" }),
      makeCapture({ id: 3, path: "/v1/embed" }),
    ];

    render(
      <CaptureList captures={captures} selectedId={null} onSelect={onSelect} {...baseProps} />,
    );
    await flushEffects();

    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");

    // Click the third row
    await user.click(options[2]);
    expect(onSelect).toHaveBeenCalledWith(3);

    // activeIndex should now be 2 -> capture-opt-3
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-3");

    // ArrowDown should clamp at last (index 2)
    listbox.focus();
    await user.keyboard("{ArrowDown}");
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-3");
  });

  it("syncs activeIndex when selectedId prop changes", async () => {
    const captures = [
      makeCapture({ id: 1, path: "/v1/messages" }),
      makeCapture({ id: 2, path: "/v1/chat" }),
      makeCapture({ id: 3, path: "/v1/embed" }),
    ];

    const { rerender } = render(
      <CaptureList captures={captures} selectedId={null} onSelect={vi.fn()} {...baseProps} />,
    );
    await flushEffects();

    const listbox = screen.getByRole("listbox");
    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-1");

    rerender(<CaptureList captures={captures} selectedId={3} onSelect={vi.fn()} {...baseProps} />);

    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-3");
  });

  it("guards keyboard when list is empty", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();

    render(<CaptureList captures={[]} selectedId={null} onSelect={onSelect} {...baseProps} />);
    await flushEffects();

    // When the list is empty, the container has no listbox role (no options
    // to select), but is still focusable and handles keyboard events.
    const listbox = screen.getByLabelText("Captures");
    listbox.focus();

    // None of these should crash or call onSelect
    await user.keyboard("{ArrowDown}");
    await user.keyboard("{ArrowUp}");
    await user.keyboard("{Home}");
    await user.keyboard("{End}");
    await user.keyboard("{Enter}");
    await user.keyboard(" ");

    expect(onSelect).not.toHaveBeenCalled();
    expect(listbox).not.toHaveAttribute("aria-activedescendant");
  });

  it("typeahead jumps to first matching path", async () => {
    const user = userEvent.setup();
    const captures = [
      makeCapture({ id: 1, path: "/v1/messages" }),
      makeCapture({ id: 2, path: "/v1/chat" }),
      makeCapture({ id: 3, path: "/v1/embed" }),
    ];

    render(<CaptureList captures={captures} selectedId={null} onSelect={vi.fn()} {...baseProps} />);
    await flushEffects();

    const listbox = screen.getByRole("listbox");
    listbox.focus();

    // Type "/v1/e" -> should jump to capture 3 (/v1/embed)
    await user.keyboard("/");
    await user.keyboard("v");
    await user.keyboard("1");
    await user.keyboard("/");
    await user.keyboard("e");

    expect(listbox).toHaveAttribute("aria-activedescendant", "capture-opt-3");
  });

  it("hides TTFT placeholder while running until first token is recorded", async () => {
    const captures = [makeCapture({ id: 1, state: "streaming", model: "claude-3", ttft_ms: null })];

    render(<CaptureList captures={captures} selectedId={null} onSelect={vi.fn()} {...baseProps} />);
    await flushEffects();

    const option = screen.getByRole("option");
    const pathRow = option.querySelector(".truncate.font-mono");
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(pathRow).toHaveTextContent(/claude-3/);
    expect(within(option).queryByText(/ttft/)).not.toBeInTheDocument();
  });

  it("shows model and TTFT in their own rows while streaming once available", async () => {
    const captures = [
      makeCapture({ id: 1, state: "streaming", model: "claude-sonnet-4", ttft_ms: 245 }),
    ];

    render(<CaptureList captures={captures} selectedId={null} onSelect={vi.fn()} {...baseProps} />);
    await flushEffects();

    const option = screen.getByRole("option");
    const pathRow = option.querySelector(".truncate.font-mono");
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(pathRow).toHaveTextContent(/claude-sonnet-4/);
    expect(within(option).getByText(/ttft 245ms/)).toBeInTheDocument();
  });
});
