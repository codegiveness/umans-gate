import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { IncidentsTab } from "@/components/incidents-tab";
import { flushEffects } from "@/test/utils";
import type { CaptureSummary, IncidentRow } from "@/types";

let fetchMock: ReturnType<typeof vi.fn>;
const originalFetch = globalThis.fetch;

function makeCapture(id: number): CaptureSummary {
  return {
    id,
    method: "POST",
    path: "/v1/messages",
    response_status: 500,
    is_sse: false,
    content_type: "application/json",
    request_size: 100,
    response_size: 200,
    duration_ms: 50,
    state: "done",
    started_at: Date.now() - 1000,
    finished_at: Date.now(),
    incoming_protocol: "http1.1",
    upstream_protocol: "http1.1",
    model: "test-model",
    usage_missing: false,
    ttft_ms: null,
    tps: null,
    cache_creation_tokens: null,
    cache_read_tokens: null,
    total_input_tokens: null,
    output_tokens: null,
    total_output_tokens: null,
    is_vision: false,
    status_source: "upstream",
    gate_reason: null,
    retry_attempt: null,
    ttft_exceeded: null,
  };
}

function makeIncident(overrides: Partial<IncidentRow> = {}): IncidentRow {
  return {
    id: 1,
    capture_id: 100,
    responsible_party: "upstream",
    incident_type: "upstream_error",
    upstream_status: 500,
    served_status: 500,
    reason: null,
    retry_attempt: null,
    ttft_exceeded: null,
    created_at: Date.now(),
    capture_model: "test-model",
    capture_path: "/v1/messages",
    ...overrides,
  };
}

function mockIncidentsGet(incidents: IncidentRow[]) {
  fetchMock.mockImplementation(async (input: string | URL) => {
    const url = input.toString();
    if (url.includes("/dashboard/api/incidents")) {
      return new Response(JSON.stringify(incidents), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not found", { status: 404 });
  });
}

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function defaultProps(overrides: Partial<Parameters<typeof IncidentsTab>[0]> = {}) {
  return {
    selectCapture: vi.fn(),
    navigateToCaptures: vi.fn(),
    captures: [] as CaptureSummary[],
    ...overrides,
  };
}

describe("IncidentsTab", () => {
  it("renders default Upstream sub-tab and context-aware empty state", async () => {
    mockIncidentsGet([]);
    render(<IncidentsTab {...defaultProps()} />);
    await flushEffects();

    const upstreamTab = screen.getByRole("tab", { name: "Upstream" });
    expect(upstreamTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("No upstream errors recorded in this window.")).toBeInTheDocument();
  });

  it("shows Proxy-specific empty state when proxy sub-tab active", async () => {
    mockIncidentsGet([]);
    render(<IncidentsTab {...defaultProps()} />);
    await flushEffects();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Proxy" }));
    await waitFor(() => {
      expect(screen.getByText("No proxy-injected errors in this window.")).toBeInTheDocument();
    });
    expect(
      screen.getByText(/gate, rate limiter, and TTFT watchdog operated within bounds/i),
    ).toBeInTheDocument();
  });

  it("shows Client-specific empty state when client sub-tab active", async () => {
    mockIncidentsGet([]);
    render(<IncidentsTab {...defaultProps()} />);
    await flushEffects();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Client" }));
    await waitFor(() => {
      expect(screen.getByText("No client aborts recorded.")).toBeInTheDocument();
    });
  });

  it("renders responsible-party badges with correct colors", async () => {
    const incidents = [
      makeIncident({
        id: 1,
        capture_id: 100,
        responsible_party: "upstream",
        incident_type: "upstream_error",
      }),
      makeIncident({
        id: 2,
        capture_id: 101,
        responsible_party: "proxy",
        incident_type: "rate_limited",
      }),
      makeIncident({
        id: 3,
        capture_id: 102,
        responsible_party: "client",
        incident_type: "client_aborted",
      }),
    ];
    mockIncidentsGet(incidents);
    const { container } = render(<IncidentsTab {...defaultProps()} />);

    await waitFor(() => {
      expect(container.querySelectorAll("tbody tr")).toHaveLength(3);
    });

    const tbody = container.querySelector("tbody");
    expect(tbody).not.toBeNull();
    const upstreamBadge = within(tbody as HTMLElement).getByText("Upstream");
    expect(upstreamBadge.className).toContain("bg-cyan");

    const proxyBadge = within(tbody as HTMLElement).getByText("Proxy");
    expect(proxyBadge.className).toContain("bg-amber");

    const clientBadge = within(tbody as HTMLElement).getByText("Client");
    expect(clientBadge.className).toContain("bg-rose");
  });

  it("renders status transition with arrow", async () => {
    const incidents = [
      makeIncident({
        upstream_status: null,
        served_status: 504,
        incident_type: "ttft_timeout",
        responsible_party: "proxy",
      }),
    ];
    mockIncidentsGet(incidents);
    render(<IncidentsTab {...defaultProps()} />);
    await flushEffects();

    expect(screen.getByText("null → 504")).toBeInTheDocument();
  });

  it("makes capture-id a clickable link that calls selectCapture + navigateToCaptures", async () => {
    const incidents = [makeIncident({ capture_id: 42, responsible_party: "upstream" })];
    mockIncidentsGet(incidents);
    const selectCapture = vi.fn();
    const navigateToCaptures = vi.fn();
    render(
      <IncidentsTab
        {...defaultProps({ selectCapture, navigateToCaptures })}
        captures={[makeCapture(42)]}
      />,
    );

    const link = await screen.findByRole("button", { name: "42" });
    const user = userEvent.setup();
    await user.click(link);

    expect(selectCapture).toHaveBeenCalledWith(42);
    expect(navigateToCaptures).toHaveBeenCalled();
  });

  it("shows muted evicted state when capture not in captures list", async () => {
    const incidents = [makeIncident({ capture_id: 999, responsible_party: "upstream" })];
    mockIncidentsGet(incidents);
    render(<IncidentsTab {...defaultProps({ captures: [] })} />);

    await flushEffects();
    expect(screen.getByText(/999/)).toBeInTheDocument();
    expect(screen.getByText("(evicted)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "999" })).not.toBeInTheDocument();
  });

  it("sends responsible_party query param when switching sub-tabs", async () => {
    mockIncidentsGet([]);
    render(<IncidentsTab {...defaultProps()} />);
    await flushEffects();

    const user = userEvent.setup();
    await user.click(screen.getByRole("tab", { name: "Proxy" }));

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => c[0].toString());
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toContain("responsible_party=proxy");
    });
  });

  it("sends since query param when selecting a time window", async () => {
    mockIncidentsGet([]);
    render(<IncidentsTab {...defaultProps()} />);
    await flushEffects();

    const trigger = screen.getByRole("combobox", { name: "Window" });
    const user = userEvent.setup();
    await user.click(trigger);
    const option = await screen.findByRole("option", { name: "15 min" });
    await user.click(option);

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => c[0].toString());
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toContain("since=");
    });
  });

  it("sends incident_type query param when selecting a type", async () => {
    mockIncidentsGet([]);
    render(<IncidentsTab {...defaultProps()} />);
    await flushEffects();

    const trigger = screen.getByRole("combobox", { name: "Type" });
    const user = userEvent.setup();
    await user.click(trigger);
    const option = await screen.findByRole("option", { name: "ttft_timeout" });
    await user.click(option);

    await waitFor(() => {
      const calls = fetchMock.mock.calls.map((c) => c[0].toString());
      const lastCall = calls[calls.length - 1];
      expect(lastCall).toContain("incident_type=ttft_timeout");
    });
  });

  it("shows error state with retry button when fetch fails", async () => {
    fetchMock.mockImplementation(async () => {
      return new Response("server error", { status: 500 });
    });
    render(<IncidentsTab {...defaultProps()} />);
    await flushEffects();

    expect(screen.getByText("Failed to load incidents")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("renders a single h2 heading", async () => {
    mockIncidentsGet([]);
    const { container } = render(<IncidentsTab {...defaultProps()} />);
    await flushEffects();
    const h2s = container.querySelectorAll("h2");
    expect(h2s).toHaveLength(1);
    expect(h2s[0]).toHaveTextContent("Incidents");
  });
});

describe("IncidentsTab table content", () => {
  it("renders all columns and row data", async () => {
    const incidents = [
      makeIncident({
        id: 7,
        capture_id: 55,
        responsible_party: "proxy",
        incident_type: "ttft_timeout",
        upstream_status: null,
        served_status: 504,
        reason: "TTFT watchdog exceeded",
        retry_attempt: 2,
      }),
    ];
    mockIncidentsGet(incidents);
    const { container } = render(
      <IncidentsTab {...defaultProps({ captures: [makeCapture(55)] })} />,
    );
    await flushEffects();

    const row = await waitFor(() => {
      const r = container.querySelector("tbody tr");
      expect(r).not.toBeNull();
      return r as HTMLElement;
    });

    expect(within(row).getByText("ttft_timeout")).toBeInTheDocument();
    expect(within(row).getByText("null → 504")).toBeInTheDocument();
    expect(within(row).getByText("TTFT watchdog exceeded")).toBeInTheDocument();
    expect(within(row).getByText("2")).toBeInTheDocument();
    expect(within(row).getByText("Proxy")).toBeInTheDocument();
  });
});
