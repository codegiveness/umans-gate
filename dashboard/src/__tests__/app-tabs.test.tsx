import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { App } from "@/App";

vi.mock("@/hooks/use-captures", () => ({
  useCaptures: () => ({
    captures: [],
    selectedCapture: null,
    isLoadingDetail: false,
    isLoadingList: false,
    wsState: "down" as const,
    selectedId: null,
    gateStats: null,
    listError: null,
    gateError: null,
    detailError: null,
    selectCapture: () => {},
    clearCaptures: () => {},
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

vi.mock("@/hooks/use-vision-calls", () => ({
  useVisionCalls: () => ({
    records: [],
    loading: false,
    error: null,
    refresh: () => {},
    clear: () => {},
  }),
}));

const mockConfig = { port: 9000 };

vi.mock("@/hooks/use-config", () => ({
  useConfig: () => ({
    config: mockConfig,
    loading: false,
    error: null,
    reload: () => Promise.resolve(null),
    save: () => Promise.resolve(null),
    validate: () => Promise.resolve(null),
    reloadFromDisk: () => Promise.resolve(null),
  }),
}));

vi.mock("@/components/mode-toggle", () => ({
  ModeToggle: () => null,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

describe("App tabs heading structure", () => {
  it("renders exactly one h2 in the Captures panel", () => {
    render(<App />);
    const capturesPanel = screen.getByRole("tabpanel", { name: "Captures" });
    const h2s = within(capturesPanel).getAllByRole("heading", { level: 2 });
    expect(h2s).toHaveLength(1);
    expect(h2s[0]).toHaveTextContent("Captures");
  });

  it("renders exactly one h2 in the Vision Calls panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: "Vision Calls" }));
    const visionPanel = screen.getByRole("tabpanel", { name: "Vision Calls" });
    const h2s = await within(visionPanel).findAllByRole("heading", { level: 2 });
    expect(h2s).toHaveLength(1);
    expect(h2s[0]).toHaveTextContent("Vision Calls");
  });

  it("renders exactly one h2 in the Performance panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: "Performance" }));
    const perfPanel = screen.getByRole("tabpanel", { name: "Performance" });
    const h2s = await within(perfPanel).findAllByRole("heading", { level: 2 });
    expect(h2s).toHaveLength(1);
    expect(h2s[0]).toHaveTextContent("Performance");
  });

  it("renders exactly one h2 in the Config panel", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: "Config" }));
    const configPanel = screen.getByRole("tabpanel", { name: "Config" });
    const h2s = await within(configPanel).findAllByRole("heading", { level: 2 });
    expect(h2s).toHaveLength(1);
    expect(h2s[0]).toHaveTextContent("Configuration");
  });

  it("renders Vision Calls title as an h2", async () => {
    const user = userEvent.setup();
    render(<App />);
    await user.click(screen.getByRole("tab", { name: "Vision Calls" }));
    const visionPanel = screen.getByRole("tabpanel", { name: "Vision Calls" });
    const h2 = await within(visionPanel).findByRole("heading", { level: 2 });
    expect(h2).toHaveTextContent("Vision Calls");
  });

  it("supports keyboard arrow navigation between tab triggers", async () => {
    const user = userEvent.setup();
    render(<App />);
    const capturesTab = screen.getByRole("tab", { name: "Captures" });
    act(() => {
      capturesTab.focus();
    });
    await user.keyboard("{ArrowRight}");
    await waitFor(() => {
      expect(screen.getByRole("tab", { name: "Vision Calls" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });
  });
});
