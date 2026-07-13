import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "@/App";
import { flushEffects } from "@/test/utils";

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

vi.mock("@/components/mode-toggle", () => ({
  ModeToggle: () => null,
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

describe("App accessibility structure", () => {
  it("renders exactly one h1 (the app name)", async () => {
    render(<App />);
    await flushEffects();
    const h1s = screen.getAllByRole("heading", { level: 1 });
    expect(h1s).toHaveLength(1);
    expect(h1s[0]).toHaveTextContent("umans-gate");
  });

  it("renders a skip link pointing to #main", async () => {
    render(<App />);
    await flushEffects();
    const skipLink = screen.getByText("Skip to content");
    expect(skipLink.tagName).toBe("A");
    expect(skipLink).toHaveAttribute("href", "#main");
  });

  it("wraps tab content in a main landmark with id=main", async () => {
    render(<App />);
    await flushEffects();
    const main = screen.getByRole("main", { name: "Inspector" });
    expect(main).toHaveAttribute("id", "main");
  });
});
