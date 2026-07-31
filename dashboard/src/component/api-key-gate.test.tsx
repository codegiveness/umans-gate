import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiKeyGate } from "@/components/api-key-gate";

const mockConfigResult = vi.hoisted(() => ({
  config: { has_api_key: false } as Record<string, unknown> | null,
  loading: false,
  error: null as unknown,
  reload: vi.fn().mockResolvedValue({}),
  save: vi.fn().mockResolvedValue({ ok: true, errors: [], warnings: [], written: {} }),
  validate: vi.fn().mockResolvedValue({ ok: true, errors: [], warnings: [] }),
  reloadFromDisk: vi.fn().mockResolvedValue({
    ok: true,
    errors: [],
    warnings: [],
    applied: [],
    restartRequired: [],
    configPath: "",
  }),
  refreshFromSource: vi.fn().mockResolvedValue({ ok: true, hardCap: 5, softLimit: 3 }),
  restart: vi.fn().mockResolvedValue({ ok: true, message: "restarting" }),
}));

vi.mock("@/hooks/use-config-context", () => ({
  useConfigContext: () => mockConfigResult,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function setup(overrides: Partial<typeof mockConfigResult> = {}) {
  Object.assign(mockConfigResult, overrides);
  return render(<ApiKeyGate />);
}

describe("ApiKeyGate", () => {
  it("renders the gate when has_api_key is false", () => {
    setup({
      config: { has_api_key: false } as Record<string, unknown>,
      loading: false,
      error: null,
    });
    expect(screen.getByText("Umans API Key Required")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("sk-...")).toBeInTheDocument();
  });

  it("does not render when has_api_key is true", () => {
    setup({
      config: { has_api_key: true } as Record<string, unknown>,
      loading: false,
      error: null,
    });
    expect(screen.queryByText("Umans API Key Required")).not.toBeInTheDocument();
  });

  it("does not render while loading", () => {
    setup({ loading: true, config: null });
    expect(screen.queryByText("Umans API Key Required")).not.toBeInTheDocument();
  });

  it("does not render when there is an error", () => {
    setup({ error: new Error("network"), config: null, loading: false });
    expect(screen.queryByText("Umans API Key Required")).not.toBeInTheDocument();
  });

  it("shows validation error when submitting empty", async () => {
    const user = userEvent.setup();
    setup({
      config: { has_api_key: false } as Record<string, unknown>,
      loading: false,
      error: null,
    });
    await user.click(screen.getByRole("button", { name: /save & continue/i }));
    await waitFor(() => {
      expect(screen.getByText("API key is required")).toBeInTheDocument();
    });
  });

  it("saves the API key on valid submit", async () => {
    const user = userEvent.setup();
    setup({
      config: { has_api_key: false } as Record<string, unknown>,
      loading: false,
      error: null,
    });
    await user.type(screen.getByPlaceholderText("sk-..."), "umans-test-key-123");
    await user.click(screen.getByRole("button", { name: /save & continue/i }));
    await waitFor(() => {
      expect(mockConfigResult.save).toHaveBeenCalledWith({ umans_api_key: "umans-test-key-123" });
    });
  });

  it("shows error toast when save fails", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    setup({
      config: { has_api_key: false } as Record<string, unknown>,
      loading: false,
      error: null,
      save: vi
        .fn()
        .mockResolvedValue({ ok: false, errors: ["Invalid key"], warnings: [], written: null }),
    });
    await user.type(screen.getByPlaceholderText("sk-..."), "bad-key");
    await user.click(screen.getByRole("button", { name: /save & continue/i }));
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Failed to save API key", {
        description: "Invalid key",
      });
    });
  });

  it("disappears after successful save when has_api_key becomes true", async () => {
    const user = userEvent.setup();
    const saveImpl = vi.fn().mockImplementation(() => {
      Object.assign(mockConfigResult, {
        config: { has_api_key: true } as Record<string, unknown>,
      });
      return Promise.resolve({ ok: true, errors: [], warnings: [], written: {} });
    });
    const { rerender } = setup({
      config: { has_api_key: false } as Record<string, unknown>,
      loading: false,
      error: null,
      save: saveImpl,
    });
    expect(screen.getByText("Umans API Key Required")).toBeInTheDocument();
    await user.type(screen.getByPlaceholderText("sk-..."), "umans-test-key-123");
    await user.click(screen.getByRole("button", { name: /save & continue/i }));
    await waitFor(() => {
      expect(saveImpl).toHaveBeenCalledWith({ umans_api_key: "umans-test-key-123" });
    });
    rerender(<ApiKeyGate />);
    await waitFor(() => {
      expect(screen.queryByText("Umans API Key Required")).not.toBeInTheDocument();
    });
  });

  describe("experimental features promotion", () => {
    function getPromotionParagraph(): HTMLElement {
      const heading = screen.getByText("Heads up.");
      const paragraph = heading.closest("p");
      if (!paragraph) throw new Error("Promotion paragraph not found");
      return paragraph;
    }

    it("renders the promotion paragraph when the gate is shown", () => {
      setup({
        config: { has_api_key: false } as Record<string, unknown>,
        loading: false,
        error: null,
      });
      expect(screen.getByText("Heads up.")).toBeInTheDocument();
      const text = getPromotionParagraph().textContent ?? "";
      expect(text).toContain("enabled by default");
      expect(text).toContain("Config → Experimental");
    });

    it("does not render the promotion when the gate is hidden", () => {
      setup({
        config: { has_api_key: true } as Record<string, unknown>,
        loading: false,
        error: null,
      });
      expect(screen.queryByText("Heads up.")).not.toBeInTheDocument();
    });

    it("uses the canonical 'experimental' label in the promotion copy", () => {
      setup({
        config: { has_api_key: false } as Record<string, unknown>,
        loading: false,
        error: null,
      });
      expect((getPromotionParagraph().textContent ?? "").toLowerCase()).toContain("experimental");
    });

    it("contains the humility phrase 'anecdotal, not benchmarked'", () => {
      setup({
        config: { has_api_key: false } as Record<string, unknown>,
        loading: false,
        error: null,
      });
      expect(getPromotionParagraph().textContent ?? "").toContain("anecdotal, not benchmarked");
    });

    it("contains the 'Config → Experimental' pointer", () => {
      setup({
        config: { has_api_key: false } as Record<string, unknown>,
        loading: false,
        error: null,
      });
      expect(getPromotionParagraph().textContent ?? "").toContain("Config → Experimental");
    });

    it("does not assert benefit-claiming outcomes", () => {
      setup({
        config: { has_api_key: false } as Record<string, unknown>,
        loading: false,
        error: null,
      });
      const text = getPromotionParagraph().textContent ?? "";
      expect(text).not.toContain("boost");
      expect(text).not.toContain("fix your");
      expect(text).not.toContain("reduce TTFT");
      expect(text).not.toContain("increase cache");
      expect(text).not.toContain("improve cache");
      expect(text).not.toMatch(/\bimproves?\s+(?:cache|hit|ttft|latency|throughput)/i);
    });

    it("renders the promotion paragraph after the 'Get one here' link in DOM order", () => {
      setup({
        config: { has_api_key: false } as Record<string, unknown>,
        loading: false,
        error: null,
      });
      const getOneHereLink = screen.getByText("Get one here");
      const promotionHeading = screen.getByText("Heads up.");
      const mask = getOneHereLink.compareDocumentPosition(promotionHeading);
      expect(mask & Node.DOCUMENT_POSITION_FOLLOWING).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    });

    it("is a plain <p> element, not an alert or status region", () => {
      setup({
        config: { has_api_key: false } as Record<string, unknown>,
        loading: false,
        error: null,
      });
      const paragraph = getPromotionParagraph();
      expect(paragraph.getAttribute("role")).toBeNull();
      expect(paragraph.getAttribute("aria-live")).toBeNull();
    });

    it("does not add a button, link, or interactive element inside the promotion", () => {
      setup({
        config: { has_api_key: false } as Record<string, unknown>,
        loading: false,
        error: null,
      });
      const paragraph = getPromotionParagraph();
      expect(paragraph.querySelectorAll("a, button").length).toBe(0);
    });
  });
});
