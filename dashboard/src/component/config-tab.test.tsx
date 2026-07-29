import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConfigTab } from "@/components/config-tab";
import { flushEffects } from "@/test/utils";

const baseConfig = {
  port: 1945,
  max_captures: 200,
  db_path: "./umans-gate.db",
  idle_timeout: 255,
  upstream_protocol: "http1.1",
  compression_enabled: true,
  stamp_claude_code_enabled: false,
  stamp_model_rules: [],
  stamp_reasoning_effort_enabled: false,
  warmer_enabled: true,
  warmer_interval_ms: 20000,
  concurrency_hard_cap: 1,
  concurrency_soft_limit: 1,
  concurrency_main_reservation: 1,
  concurrency_vision_reservation: 1,
  release_cooldown_ms: 1000,
  breaker_threshold: 5,
  breaker_window_ms: 300000,
  breaker_cooldown_ms: 60000,
  queue_timeout_ms: 180000,
  max_queue_depth: 256,
  queue_max_depth: 100,
  rate_limit_requests: 0,
  umans_api_key: "",
  usage_refresh_ms: 60000,
  models_refresh_ms: 3600000,
  capture_body_max_bytes: 10000000,
  ws_backpressure_limit: 1048576,
  ws_close_on_backpressure_limit: true,
  vision_strategy: "always",
  vision_model: "umans-flash",
  vision_prompt: "test prompt",
  vision_prompt_version: 2,
  vision_max_images: 5,
  vision_max_description_tokens: 4096,
  vision_reasoning_effort: null,
  vision_timeout_ms: 180000,
  vision_cache_size: 1000,
  vision_cache_ttl_ms: 604800000,
  vision_cache_max_rows: 10000,
  vision_persistent_cache: true,
  vision_concurrency: 1,
  vision_max_dimension: 2048,
  vision_jpeg_quality: 92,
  vision_image_format: "png",
  vision_image_detail: "high",
  vision_pending_max_batch: 50,
  usage_history_enabled: true,
  usage_raw_retention_days: 7,
  usage_gap_threshold_minutes: 60,
  usage_idle_session_timeout_minutes: 5,
  upstream_timeout_ms: 1800000,
  experiment_ttft_watchdog: false,
  ttft_timeout_ms: 60000,
  ttft_retry_max_attempts: 3,
  ttft_retry_gate_saturation_pct: 80,
  ttft_retry_cooldown_ms: 5000,
  ttft_watchdog_multiplier: 5,
  ttft_watchdog_hard_cap_ms: 300000,
  performance_sample_count: 200,
};

const mockConfigResult = {
  config: baseConfig,
  loading: false,
  error: null,
  reload: vi.fn().mockResolvedValue(baseConfig),
  save: vi.fn().mockResolvedValue({ ok: true, errors: [], warnings: [], written: baseConfig }),
  validate: vi.fn().mockResolvedValue({ ok: true, errors: [], warnings: [] }),
  reloadFromDisk: vi.fn().mockResolvedValue({
    ok: true,
    errors: [],
    warnings: [],
    applied: [],
    restartRequired: [],
    configPath: "",
  }),
  refreshFromSource: vi.fn().mockResolvedValue({
    ok: true,
    hardCap: 5,
    softLimit: 3,
    requestsLimit: null,
    requestsHardCap: null,
    requestsWindowSeconds: null,
  }),
  restart: vi.fn().mockResolvedValue({ ok: true, message: "restarting" }),
};

vi.mock("@/hooks/use-config-context", () => ({
  useConfigContext: () => mockConfigResult,
}));

vi.mock("@/hooks/use-models", () => ({
  useModels: () => ({ data: { models: [] }, loading: false, error: null }),
}));

vi.mock("@/hooks/use-usage", () => ({
  useUsage: () => ({ data: null, loading: false, error: null, refresh: vi.fn() }),
}));

vi.mock("@/components/ui/sonner", () => ({
  Toaster: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

const versionState = {
  current: vi.fn(() => ({ version: null, loading: false, checking: false, checkNow: vi.fn() })),
};
vi.mock("@/hooks/use-version", () => ({
  useVersion: () => versionState.current(),
}));

describe("ConfigTab", () => {
  it("renders Save button disabled when no changes", async () => {
    render(<ConfigTab />);
    await flushEffects();
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();
  });

  it("enables Save after editing a field", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await flushEffects();
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();
    const portInput = screen.getByLabelText("Port");
    await user.clear(portInput);
    await user.type(portInput, "9001");
    await flushEffects();
    await waitFor(() => {
      expect(saveBtn).not.toBeDisabled();
    });
  });

  it("does not render Validate button", async () => {
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.queryByRole("button", { name: /Validate/i })).toBeNull();
  });

  it("does not render Reload from Disk button", async () => {
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.queryByRole("button", { name: /Reload from Disk/i })).toBeNull();
  });

  it("does not render Reload Limits from Source button", async () => {
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.queryByRole("button", { name: /Reload Limits/i })).toBeNull();
  });

  it("renders Reset Draft and Restart buttons", async () => {
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.getByRole("button", { name: "Reset Draft" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Restart/i })).toBeInTheDocument();
  });

  it("does not render field-level refresh on Hard Cap (disabled field)", async () => {
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.queryByRole("button", { name: /Refresh Hard Cap from source/i })).toBeNull();
  });

  it("does not render field-level refresh on Soft Limit (disabled field)", async () => {
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.queryByRole("button", { name: /Refresh Soft Limit from source/i })).toBeNull();
  });

  it("does not render field-level refresh on non-concurrency fields", async () => {
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.queryByRole("button", { name: /Refresh Port from source/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Refresh Host from source/i })).toBeNull();
  });

  it("Save button is not permanently disabled by vision_timeout_ms=0 default", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await flushEffects();
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();
    const portInput = screen.getByLabelText("Port");
    await user.clear(portInput);
    await user.type(portInput, "9001");
    await flushEffects();
    await waitFor(() => {
      expect(saveBtn).not.toBeDisabled();
    });
  });

  it("shows error when editing a number below min", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await flushEffects();
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    await flushEffects();
    const maxDescTokensInput = screen.getByLabelText("Max Description Tokens");
    await user.clear(maxDescTokensInput);
    await user.type(maxDescTokensInput, "0");
    await flushEffects();
    await waitFor(() => {
      expect(screen.getByText(/Max Description Tokens must be ≥ 1/i)).toBeInTheDocument();
    });
    const saveBtn = screen.getByRole("button", { name: "Save" });
    expect(saveBtn).toBeDisabled();
  });

  it("Reset Draft reverts changes", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await flushEffects();
    const portInput = screen.getByLabelText("Port");
    await user.clear(portInput);
    await user.type(portInput, "9001");
    await flushEffects();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });
    await user.click(screen.getByRole("button", { name: "Reset Draft" }));
    await flushEffects();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    });
  });

  it("Save button shows Saving… while save is in flight", async () => {
    const user = userEvent.setup();
    const originalSave = mockConfigResult.save;
    mockConfigResult.save = vi.fn().mockImplementation(() => new Promise(() => {}));
    render(<ConfigTab />);
    await flushEffects();
    const portInput = screen.getByLabelText("Port");
    await user.clear(portInput);
    await user.type(portInput, "9001");
    await flushEffects();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await flushEffects();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Saving…" })).toBeDisabled();
    });
    mockConfigResult.save = originalSave;
  });

  it("vision_timeout_ms=0 does not produce a client error", async () => {
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.queryByText(/Timeout must be ≥/i)).toBeNull();
  });

  it("vision_timeout_ms accepts 0 without blocking save", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await flushEffects();
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    await flushEffects();
    const timeoutInput = screen.getByLabelText("Timeout");
    await user.clear(timeoutInput);
    await user.type(timeoutInput, "0");
    await flushEffects();
    await user.click(screen.getByRole("tab", { name: "General" }));
    await flushEffects();
    const portInput = screen.getByLabelText("Port");
    await user.clear(portInput);
    await user.type(portInput, "9001");
    await flushEffects();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });
  });

  it("shows warning toast when reloadFromDisk fails after save", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    const originalReload = mockConfigResult.reloadFromDisk;
    mockConfigResult.reloadFromDisk = vi.fn().mockResolvedValue(null);
    render(<ConfigTab />);
    await flushEffects();
    const portInput = screen.getByLabelText("Port");
    await user.clear(portInput);
    await user.type(portInput, "9001");
    await flushEffects();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await flushEffects();
    await waitFor(() => {
      expect(toast.warning).toHaveBeenCalledWith(
        "Config saved",
        expect.objectContaining({
          description: expect.stringContaining("Restart to apply"),
        }),
      );
    });
    mockConfigResult.reloadFromDisk = originalReload;
  });

  it("save success calls save() and reloadFromDisk() and shows success toast", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    const saveSpy = vi.fn().mockResolvedValue({
      ok: true,
      errors: [],
      warnings: [],
      written: { ...baseConfig, port: 9001 },
    });
    const reloadSpy = vi.fn().mockResolvedValue({
      ok: true,
      errors: [],
      warnings: [],
      applied: ["port"],
      restartRequired: [],
      configPath: "",
    });
    const originalSave = mockConfigResult.save;
    const originalReload = mockConfigResult.reloadFromDisk;
    mockConfigResult.save = saveSpy;
    mockConfigResult.reloadFromDisk = reloadSpy;
    render(<ConfigTab />);
    await flushEffects();
    const portInput = screen.getByLabelText("Port");
    await user.clear(portInput);
    await user.type(portInput, "9001");
    await flushEffects();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await flushEffects();
    await waitFor(() => {
      expect(saveSpy).toHaveBeenCalledTimes(1);
    });
    expect(reloadSpy).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(
      "Config saved",
      expect.objectContaining({ description: "Saved and applied live." }),
    );
    mockConfigResult.save = originalSave;
    mockConfigResult.reloadFromDisk = originalReload;
  });

  it("save failure shows error toast with server errors", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    const saveSpy = vi.fn().mockResolvedValue({
      ok: false,
      errors: ["port: must be between 1 and 65535"],
      warnings: [],
      written: null,
    });
    const originalSave = mockConfigResult.save;
    mockConfigResult.save = saveSpy;
    render(<ConfigTab />);
    await flushEffects();
    const portInput = screen.getByLabelText("Port");
    await user.clear(portInput);
    await user.type(portInput, "9001");
    await flushEffects();
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Save" })).not.toBeDisabled();
    });
    await user.click(screen.getByRole("button", { name: "Save" }));
    await flushEffects();
    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith(
        "Save rejected",
        expect.objectContaining({ description: expect.stringContaining("must be between") }),
      );
    });
    mockConfigResult.save = originalSave;
  });

  it("clicking refresh source icon calls refreshFromSource and shows toast", async () => {
    const user = userEvent.setup();
    const { toast } = await import("sonner");
    const refreshSpy = vi.fn().mockResolvedValue({
      ok: true,
      hardCap: 10,
      softLimit: 5,
      requestsLimit: null,
      requestsHardCap: null,
      requestsWindowSeconds: null,
    });
    const originalRefresh = mockConfigResult.refreshFromSource;
    mockConfigResult.refreshFromSource = refreshSpy;
    render(<ConfigTab />);
    await flushEffects();
    const refreshBtn = screen.getByRole("button", { name: /Refresh Rate Limit from source/i });
    await user.click(refreshBtn);
    await flushEffects();
    await waitFor(() => {
      expect(refreshSpy).toHaveBeenCalledTimes(1);
    });
    expect(toast.success).toHaveBeenCalledWith(
      "Limits reloaded from source",
      expect.objectContaining({
        description: expect.stringContaining("Hard cap set to 10"),
      }),
    );
    mockConfigResult.refreshFromSource = originalRefresh;
  });

  describe("group structure (Card wrap + breaker move + OMO reorder)", () => {
    it("renders the active group Card with its title, and switches per sub-tab", async () => {
      const user = userEvent.setup();
      render(<ConfigTab />);
      await flushEffects();
      const generalCards = document.querySelectorAll("[data-group-card]");
      expect(generalCards).toHaveLength(1);
      expect(generalCards[0]?.textContent).toContain("General");
      await user.click(screen.getByRole("tab", { name: "Experimental" }));
      await flushEffects();
      const experimentalCards = document.querySelectorAll("[data-group-card]");
      expect(experimentalCards).toHaveLength(1);
      expect(experimentalCards[0]?.textContent).toContain("Experimental");
      await user.click(screen.getByRole("tab", { name: "Advanced" }));
      await flushEffects();
      const advancedCards = document.querySelectorAll("[data-group-card]");
      expect(advancedCards).toHaveLength(1);
      expect(advancedCards[0]?.textContent).toContain("Advanced");
    });

    it("places Circuit Breaker fields within the General group", async () => {
      render(<ConfigTab />);
      await flushEffects();
      const breakerLabel = screen.getByText("Breaker Threshold");
      const generalCard = breakerLabel.closest("[data-group-card]");
      expect(generalCard).not.toBeNull();
      expect(generalCard?.textContent).toContain("General");
      expect(generalCard?.textContent).not.toContain("Advanced");
    });

    it("places oh-my-openagent as the last section of Experimental group", async () => {
      const user = userEvent.setup();
      render(<ConfigTab />);
      await flushEffects();
      await user.click(screen.getByRole("tab", { name: "Experimental" }));
      await flushEffects();
      const experimentalCard = document.querySelector("[data-group-card]");
      expect(experimentalCard).not.toBeNull();
      const sectionHeadings = Array.from(experimentalCard?.querySelectorAll("h4") ?? []).map(
        (h) => h.textContent ?? "",
      );
      expect(sectionHeadings.length).toBeGreaterThanOrEqual(4);
      expect(sectionHeadings[sectionHeadings.length - 1]).toContain("oh-my-openagent");
      const ttftIdx = sectionHeadings.findIndex((s) => s.includes("TTFT Watchdog"));
      const omoIdx = sectionHeadings.findIndex((s) => s.includes("oh-my-openagent"));
      expect(ttftIdx).toBeGreaterThanOrEqual(0);
      expect(omoIdx).toBeGreaterThan(ttftIdx);
    });
  });

  describe("experimental-active banner", () => {
    it("does not render the banner when all experimental flags are false (default baseConfig)", async () => {
      render(<ConfigTab />);
      await flushEffects();
      expect(screen.queryByText(/Experimental features active/i)).toBeNull();
    });

    it("renders the banner when an experimental flag is on", async () => {
      const withExperimental = {
        ...baseConfig,
        experiment_ttft_watchdog: true,
      };
      mockConfigResult.config = withExperimental;
      mockConfigResult.reload.mockResolvedValue(withExperimental);
      render(<ConfigTab />);
      await flushEffects();
      expect(screen.getByText(/Experimental features active/i)).toBeInTheDocument();
      expect(screen.getByText(/run at your own risk/i)).toBeInTheDocument();
      mockConfigResult.config = baseConfig;
      mockConfigResult.reload.mockResolvedValue(baseConfig);
    });
  });
});

describe("ConfigTab sub-tabs", () => {
  const upToDateVersion = {
    current: "0.4.0",
    latest: "0.4.0",
    updateAvailable: false,
    lastCheckedAt: Date.now(),
    error: null,
    releaseNotes: null,
    canUpdate: false,
    canUpdateReason: null,
  };

  beforeEach(() => {
    versionState.current.mockReturnValue({
      version: upToDateVersion,
      loading: false,
      checking: false,
      checkNow: vi.fn(),
    });
  });

  afterEach(() => {
    versionState.current.mockReset();
    mockConfigResult.config = baseConfig;
    mockConfigResult.reload.mockResolvedValue(baseConfig);
  });

  it("renders three sub-tab triggers labeled General, Experimental, Advanced", async () => {
    render(<ConfigTab />);
    await flushEffects();
    const triggers = screen.getAllByRole("tab");
    const labels = triggers.map((t) => t.textContent ?? "");
    expect(labels).toEqual(["General", "Experimental", "Advanced"]);
  });

  it("defaults to General pane on initial render (Port visible, VersionSection visible)", async () => {
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.getByLabelText("Port")).toBeInTheDocument();
    expect(screen.getByText("v0.4.0")).toBeInTheDocument();
  });

  it("does not render Experimental or Advanced fields on initial render", async () => {
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.queryByLabelText("Claude Code Style")).toBeNull();
    expect(screen.queryByLabelText("Queue Timeout")).toBeNull();
  });

  it("clicking Experimental shows Experimental content and hides General content", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.getByLabelText("Port")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Experimental" }));
    await flushEffects();
    expect(screen.getByRole("switch", { name: "Claude Code Style" })).toBeInTheDocument();
    expect(screen.queryByLabelText("Port")).toBeNull();
  });

  it("clicking Advanced shows Advanced content and hides General + Experimental", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await flushEffects();
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    await flushEffects();
    expect(screen.getByLabelText("Queue Timeout")).toBeInTheDocument();
    expect(screen.queryByLabelText("Port")).toBeNull();
    expect(screen.queryByLabelText("Claude Code Style")).toBeNull();
  });

  it("shows the experimental-active banner on all three sub-tabs when an experimental flag is on", async () => {
    const user = userEvent.setup();
    const withExperimental = { ...baseConfig, stamp_claude_code_enabled: true };
    mockConfigResult.config = withExperimental;
    mockConfigResult.reload.mockResolvedValue(withExperimental);
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.getByText(/Experimental features active/i)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Experimental" }));
    await flushEffects();
    expect(screen.getByText(/Experimental features active/i)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    await flushEffects();
    expect(screen.getByText(/Experimental features active/i)).toBeInTheDocument();
  });

  it("renders the Save button regardless of active sub-tab", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Experimental" }));
    await flushEffects();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    await flushEffects();
    expect(screen.getByRole("button", { name: "Save" })).toBeInTheDocument();
  });

  it("renders the restart-required footer note on all three sub-tabs", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.getByText(/require a server restart to take effect/i)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Experimental" }));
    await flushEffects();
    expect(screen.getByText(/require a server restart to take effect/i)).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    await flushEffects();
    expect(screen.getByText(/require a server restart to take effect/i)).toBeInTheDocument();
  });

  it("renders VersionSection only on General pane (not on Experimental or Advanced)", async () => {
    const user = userEvent.setup();
    render(<ConfigTab />);
    await flushEffects();
    expect(screen.getByText("v0.4.0")).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Experimental" }));
    await flushEffects();
    expect(screen.queryByText("v0.4.0")).toBeNull();
    await user.click(screen.getByRole("tab", { name: "Advanced" }));
    await flushEffects();
    expect(screen.queryByText("v0.4.0")).toBeNull();
  });
});
