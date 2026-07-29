import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the tooltip so content renders inline (jsdom doesn't support portals well).
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

const useVersionMock = vi.fn();

vi.mock("@/hooks/use-version", () => ({
  useVersion: () => useVersionMock(),
}));

import { UpdateIndicator } from "@/components/update-indicator";

beforeEach(() => {
  useVersionMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function makeVersion(
  overrides: Partial<{
    current: string;
    latest: string | null;
    updateAvailable: boolean;
  }>,
) {
  return {
    current: "0.3.14",
    latest: "0.3.15",
    updateAvailable: true,
    lastCheckedAt: Date.now(),
    error: null,
    releaseNotes: null,
    canUpdate: false,
    canUpdateReason: null,
    ...overrides,
  };
}

describe("UpdateIndicator", () => {
  it("renders null when no update is available", () => {
    useVersionMock.mockReturnValue({
      version: makeVersion({ updateAvailable: false, latest: "0.3.14" }),
      loading: false,
      checking: false,
      checkNow: vi.fn(),
    });
    const { container } = render(<UpdateIndicator onNavigateToConfig={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders null while loading and version is null", () => {
    useVersionMock.mockReturnValue({
      version: null,
      loading: true,
      checking: false,
      checkNow: vi.fn(),
    });
    const { container } = render(<UpdateIndicator onNavigateToConfig={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders the icon when an update is available", () => {
    useVersionMock.mockReturnValue({
      version: makeVersion({ updateAvailable: true, latest: "0.3.15" }),
      loading: false,
      checking: false,
      checkNow: vi.fn(),
    });
    render(<UpdateIndicator onNavigateToConfig={() => {}} />);
    expect(screen.getByRole("button", { name: /update available/i })).toBeInTheDocument();
  });

  it("tooltip shows the version transition text", () => {
    useVersionMock.mockReturnValue({
      version: makeVersion({ current: "0.3.14", latest: "0.3.15", updateAvailable: true }),
      loading: false,
      checking: false,
      checkNow: vi.fn(),
    });
    render(<UpdateIndicator onNavigateToConfig={() => {}} />);
    expect(screen.getByText("v0.3.14 → v0.3.15 available")).toBeInTheDocument();
  });

  it("calls onNavigateToConfig when clicked", async () => {
    const user = userEvent.setup();
    const onNavigateToConfig = vi.fn();
    useVersionMock.mockReturnValue({
      version: makeVersion({ updateAvailable: true, latest: "0.3.15" }),
      loading: false,
      checking: false,
      checkNow: vi.fn(),
    });
    render(<UpdateIndicator onNavigateToConfig={onNavigateToConfig} />);
    await user.click(screen.getByRole("button", { name: /update available/i }));
    expect(onNavigateToConfig).toHaveBeenCalledTimes(1);
  });
});
