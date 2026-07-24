import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock tooltip so content renders inline (jsdom doesn't render portals).
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// Mock alert-dialog so content renders inline without portal animation.
vi.mock("@/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children, open }: { children: ReactNode; open?: boolean }) =>
    open ? children : null,
  AlertDialogTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  AlertDialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogAction: ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children }: { children: ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

import { VersionSection } from "@/components/version-section";
import type { VersionInfo } from "@/hooks/use-version";

const versionData: VersionInfo = {
  current: "0.3.14",
  latest: "0.3.15",
  updateAvailable: true,
  lastCheckedAt: Date.now() - 60000,
  error: null,
  releaseNotes: "## What's Changed\n\n- Bug fixes\n- New feature",
  canUpdate: false,
  canUpdateReason: "no_service",
};

const upToDateData: VersionInfo = {
  ...versionData,
  latest: "0.3.14",
  updateAvailable: false,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

function mockVersionGet(data: VersionInfo) {
  fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
    const url = input.toString();
    const method = init?.method ?? "GET";
    if (url.includes("/dashboard/api/version/check") && method === "POST") {
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/dashboard/api/update") && method === "POST") {
      return new Response(JSON.stringify({ ok: true, targetVersion: data.latest }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/dashboard/api/version") && method === "GET") {
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/health")) {
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  });
}

describe("VersionSection", () => {
  it("renders current version and update-available badge", async () => {
    mockVersionGet(versionData);
    render(<VersionSection />);
    await waitFor(() => {
      expect(screen.getByText("v0.3.14")).toBeInTheDocument();
    });
    expect(screen.getByText(/v0.3.15 available/i)).toBeInTheDocument();
  });

  it("renders up-to-date badge when no update available", async () => {
    mockVersionGet(upToDateData);
    render(<VersionSection />);
    await waitFor(() => {
      expect(screen.getByText("v0.3.14")).toBeInTheDocument();
    });
    expect(screen.getByText(/Up to date/i)).toBeInTheDocument();
  });

  it("renders Check now button", async () => {
    mockVersionGet(versionData);
    render(<VersionSection />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Check now/i })).toBeInTheDocument();
    });
  });

  it("Check now button triggers a refresh", async () => {
    const user = userEvent.setup();
    mockVersionGet(versionData);
    render(<VersionSection />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Check now/i })).toBeInTheDocument();
    });
    const initialCallCount = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /Check now/i }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
    const checkCall = fetchMock.mock.calls.find((call) => {
      const url = String(call[0]);
      return url.includes("/version/check");
    });
    expect(checkCall).toBeDefined();
  });

  it("renders error state with retry button", async () => {
    const errorData = {
      ...versionData,
      latest: null,
      updateAvailable: false,
      error: "npm registry unreachable: connection refused",
    };
    mockVersionGet(errorData);
    render(<VersionSection />);
    await waitFor(() => {
      expect(screen.getByText(/Version check failed/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });

  it("retry button triggers a check", async () => {
    const user = userEvent.setup();
    const errorData = {
      ...versionData,
      latest: null,
      updateAvailable: false,
      error: "npm registry unreachable: connection refused",
    };
    mockVersionGet(errorData);
    render(<VersionSection />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
    });
    const initialCallCount = fetchMock.mock.calls.length;
    await user.click(screen.getByRole("button", { name: /Retry/i }));
    await waitFor(() => {
      expect(fetchMock.mock.calls.length).toBeGreaterThan(initialCallCount);
    });
  });

  it("does not render What's new section when releaseNotes is null", async () => {
    mockVersionGet({ ...versionData, releaseNotes: null });
    render(<VersionSection />);
    await waitFor(() => {
      expect(screen.getByText("v0.3.14")).toBeInTheDocument();
    });
    expect(screen.queryByText(/What's new/i)).not.toBeInTheDocument();
  });

  it("renders What's new collapsible when releaseNotes is non-null", async () => {
    mockVersionGet(versionData);
    render(<VersionSection />);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /What's new/i })).toBeInTheDocument();
    });
    expect(screen.queryByText(/Bug fixes/)).not.toBeInTheDocument();
  });

  it("toggles release notes on click of What's new", async () => {
    const user = userEvent.setup();
    mockVersionGet(versionData);
    render(<VersionSection />);
    const toggle = await screen.findByRole("button", { name: /What's new/i });
    expect(screen.queryByText(/Bug fixes/)).not.toBeInTheDocument();
    await user.click(toggle);
    expect(screen.getByText(/Bug fixes/)).toBeInTheDocument();
    await user.click(toggle);
    expect(screen.queryByText(/Bug fixes/)).not.toBeInTheDocument();
  });
});

describe("VersionSection update button", () => {
  it("shows disabled Update button with no_service tooltip when canUpdate is false", async () => {
    mockVersionGet({ ...versionData, canUpdate: false, canUpdateReason: "no_service" });
    render(<VersionSection />);
    const btn = await screen.findByRole("button", { name: /Update to v0\.3\.15/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/umans-gate service install/i)).toBeInTheDocument();
  });

  it("shows disabled Update button with no_token tooltip when canUpdate is false", async () => {
    mockVersionGet({ ...versionData, canUpdate: false, canUpdateReason: "no_token" });
    render(<VersionSection />);
    const btn = await screen.findByRole("button", { name: /Update to v0\.3\.15/i });
    expect(btn).toBeDisabled();
    expect(screen.getByText(/Set DASHBOARD_TOKEN/i)).toBeInTheDocument();
  });

  it("shows enabled Update button when canUpdate is true and updateAvailable is true", async () => {
    mockVersionGet({ ...versionData, canUpdate: true, canUpdateReason: null });
    render(<VersionSection />);
    const btn = await screen.findByRole("button", { name: /Update to v0\.3\.15/i });
    expect(btn).not.toBeDisabled();
  });

  it("opens confirmation dialog on Update click", async () => {
    const user = userEvent.setup();
    mockVersionGet({ ...versionData, canUpdate: true, canUpdateReason: null });
    render(<VersionSection />);
    const btn = await screen.findByRole("button", { name: /Update to v0\.3\.15/i });
    await user.click(btn);
    expect(screen.getByText(/Update to v0\.3\.15\?/i)).toBeInTheDocument();
    expect(
      screen.getByText(/This will stop the proxy, update to v0\.3\.15, and restart/i),
    ).toBeInTheDocument();
  });

  it("enters updating state after confirmation", async () => {
    const user = userEvent.setup();
    mockVersionGet({ ...versionData, canUpdate: true, canUpdateReason: null });
    render(<VersionSection />);
    const btn = await screen.findByRole("button", { name: /Update to v0\.3\.15/i });
    await user.click(btn);
    const confirmBtn = await screen.findByRole("button", { name: /^Update$/i });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.getByText(/Updating to v0\.3\.15.*reconnecting/i)).toBeInTheDocument();
    });
    expect(document.querySelector(".animate-spin")).toBeInTheDocument();
  });

  it("shows error state when pre-flight fails", async () => {
    const user = userEvent.setup();
    fetchMock.mockImplementation(async (input: string | URL, init?: RequestInit) => {
      const url = input.toString();
      const method = init?.method ?? "GET";
      if (url.includes("/dashboard/api/update") && method === "POST") {
        return new Response(JSON.stringify({ ok: false, error: "not_service_managed" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.includes("/dashboard/api/version") && method === "GET") {
        return new Response(
          JSON.stringify({ ...versionData, canUpdate: true, canUpdateReason: null }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("not found", { status: 404 });
    });
    render(<VersionSection />);
    const btn = await screen.findByRole("button", { name: /Update to v0\.3\.15/i });
    await user.click(btn);
    const confirmBtn = await screen.findByRole("button", { name: /^Update$/i });
    await user.click(confirmBtn);
    await waitFor(() => {
      expect(screen.getByText(/Update failed.*not running as a service/i)).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: /Dismiss/i })).toBeInTheDocument();
  });
});
