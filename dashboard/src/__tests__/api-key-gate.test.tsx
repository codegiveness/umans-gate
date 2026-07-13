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
});
