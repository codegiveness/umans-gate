import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CaptureDetailPanel } from "@/components/capture-detail";
import { flushEffects } from "@/test/utils";
import type { CaptureDetail } from "@/types";

// Mock heavy child viewers to keep the test focused on panel transitions.
vi.mock("@/components/json-viewer", () => ({
  JsonViewer: ({ body }: { body: string }) => <div data-testid="json-viewer">{body}</div>,
}));

vi.mock("@/components/headers-viewer", () => ({
  HeadersViewer: ({ headers }: { headers: string }) => (
    <div data-testid="headers-viewer">{headers}</div>
  ),
}));

vi.mock("@/components/sse-viewer", () => ({
  SseViewer: ({ body }: { body: string }) => <div data-testid="sse-viewer">{body}</div>,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="scroll-area">{children}</div>
  ),
}));

function makeCapture(overrides: Partial<CaptureDetail> = {}): CaptureDetail {
  return {
    id: 1,
    method: "POST",
    path: "/v1/messages",
    url: "https://api.anthropic.com/v1/messages",
    response_status: 200,
    is_sse: false,
    content_type: "application/json",
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
    request_headers: '{"content-type":"application/json"}',
    request_body: '{"model":"claude-3","messages":[]}',
    response_headers: '{"content-type":"application/json"}',
    response_body: '{"id":"msg_1","content":[]}',
    ...overrides,
  };
}

const baseProps = {
  onCopy: vi.fn().mockResolvedValue(true),
  onRetry: vi.fn(),
};

describe("CaptureDetailPanel transitions", () => {
  it("renders Loader when isLoading is true", () => {
    render(
      <CaptureDetailPanel capture={null} isLoading={true} detailError={null} {...baseProps} />,
    );

    const spinner = document.querySelector(".animate-spin");
    expect(spinner).not.toBeNull();

    expect(screen.queryByText("Select a capture to inspect")).not.toBeInTheDocument();
  });

  it("renders EmptyState when not loading, no capture, and no error", () => {
    render(
      <CaptureDetailPanel capture={null} isLoading={false} detailError={null} {...baseProps} />,
    );

    expect(screen.getByText("Select a capture to inspect")).toBeInTheDocument();
    expect(screen.getByText(/Requests appear here automatically/)).toBeInTheDocument();
  });

  it("renders ErrorState when not loading, no capture, but detailError is set", () => {
    render(
      <CaptureDetailPanel
        capture={null}
        isLoading={false}
        detailError="HTTP 500 Internal Server Error"
        onCopy={vi.fn().mockResolvedValue(true)}
        onRetry={baseProps.onRetry}
      />,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("HTTP 500 Internal Server Error")).toBeInTheDocument();

    // Retry button should call onRetry
    const retryButton = screen.getByRole("button", { name: /retry/i });
    expect(retryButton).toBeInTheDocument();
  });

  it("calls onRetry when Retry button is clicked in error state", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();

    render(
      <CaptureDetailPanel
        capture={null}
        isLoading={false}
        detailError="Fetch failed"
        onCopy={vi.fn().mockResolvedValue(true)}
        onRetry={onRetry}
      />,
    );

    await user.click(screen.getByRole("button", { name: /retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("renders detail content when capture is loaded", async () => {
    const capture = makeCapture();

    render(
      <CaptureDetailPanel capture={capture} isLoading={false} detailError={null} {...baseProps} />,
    );
    await flushEffects();

    // Method and path are shown in the header as "POST /v1/messages"
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("POST /v1/messages");

    // URL is shown
    expect(screen.getByText("https://api.anthropic.com/v1/messages")).toBeInTheDocument();

    // Tabs are present
    expect(screen.getByRole("tab", { name: "Response Body" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Request Body" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Response Headers" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Request Headers" })).toBeInTheDocument();

    // Copy button is present
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("transitions from loading to empty to loaded across rerenders", () => {
    const { rerender } = render(
      <CaptureDetailPanel capture={null} isLoading={true} detailError={null} {...baseProps} />,
    );

    // Loading: skeleton visible, empty text absent
    expect(screen.queryByText("Select a capture to inspect")).not.toBeInTheDocument();

    // Transition to empty
    rerender(
      <CaptureDetailPanel capture={null} isLoading={false} detailError={null} {...baseProps} />,
    );

    expect(screen.getByText("Select a capture to inspect")).toBeInTheDocument();

    // Transition to loaded
    const capture = makeCapture();
    rerender(
      <CaptureDetailPanel capture={capture} isLoading={false} detailError={null} {...baseProps} />,
    );

    expect(screen.queryByText("Select a capture to inspect")).not.toBeInTheDocument();
    const heading = screen.getByRole("heading", { level: 2 });
    expect(heading).toHaveTextContent("POST /v1/messages");
  });

  it("calls onCopyStatus with initial label on mount", () => {
    const onCopyStatus = vi.fn();

    render(
      <CaptureDetailPanel
        capture={null}
        isLoading={false}
        detailError={null}
        onCopy={vi.fn().mockResolvedValue(true)}
        onRetry={vi.fn()}
        onCopyStatus={onCopyStatus}
      />,
    );

    expect(onCopyStatus).toHaveBeenCalledWith("Copy");
  });

  it("updates copy label and calls onCopy when Copy button is clicked", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn().mockResolvedValue(true);
    const onCopyStatus = vi.fn();
    const capture = makeCapture();

    render(
      <CaptureDetailPanel
        capture={capture}
        isLoading={false}
        detailError={null}
        onCopy={onCopy}
        onRetry={vi.fn()}
        onCopyStatus={onCopyStatus}
      />,
    );

    const copyButton = screen.getByRole("button", { name: /copy/i });
    await user.click(copyButton);

    expect(onCopy).toHaveBeenCalledOnce();
    // onCopy was called with the response body (active tab = "response")
    expect(onCopy).toHaveBeenCalledWith(capture.response_body);

    // Label should update to "Copied!" after successful copy
    expect(onCopyStatus).toHaveBeenCalledWith("Copied!");
  });

  it("shows SSE badge when capture is_sse is true", async () => {
    const capture = makeCapture({ is_sse: true });

    render(
      <CaptureDetailPanel capture={capture} isLoading={false} detailError={null} {...baseProps} />,
    );
    await flushEffects();

    expect(screen.getByText("SSE")).toBeInTheDocument();
  });

  it("shows live badge when capture state is streaming", () => {
    const capture = makeCapture({ state: "streaming" });

    render(
      <CaptureDetailPanel capture={capture} isLoading={false} detailError={null} {...baseProps} />,
    );

    expect(screen.getByText("live")).toBeInTheDocument();
  });
});
