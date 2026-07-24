import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
    if (url.includes("/dashboard/api/version") && method === "GET") {
      return new Response(JSON.stringify(data), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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
