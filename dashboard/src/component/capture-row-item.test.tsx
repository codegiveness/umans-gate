import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CaptureRowItem } from "@/components/capture-row-item";
import { flushEffects } from "@/test/utils";
import type { CaptureSummary } from "@/types";

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

function makeCapture(overrides: Partial<CaptureSummary> = {}): CaptureSummary {
  return {
    id: 1,
    method: "POST",
    path: "/v1/messages",
    response_status: 200,
    is_sse: false,
    content_type: null,
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
    retry_attempt: null,
    ttft_exceeded: null,
    upstream_ttft_p50_ms: null,
    upstream_tps_p50: null,
    ...overrides,
  };
}

describe("CaptureRowItem badge state diagram", () => {
  it("shows running badge on attempt 1 (streaming, no retry)", async () => {
    const c = makeCapture({ id: 1, state: "streaming" });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText("running")).toBeInTheDocument();
  });

  it("shows retried badge when state=done and retry_attempt > 0", async () => {
    const c = makeCapture({ id: 1, state: "done", retry_attempt: 2 });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText("retried")).toBeInTheDocument();
  });

  it("does NOT render retried badge when retry_attempt is 0", async () => {
    const c = makeCapture({ id: 1, state: "done", retry_attempt: 0 });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.queryByText("retried")).not.toBeInTheDocument();
  });

  it("shows done badge (no retry badge) when state=done and retry_attempt is null", async () => {
    const c = makeCapture({ id: 1, state: "done", retry_attempt: null });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.queryByText("retried")).not.toBeInTheDocument();
    expect(screen.queryByText("running")).not.toBeInTheDocument();
  });

  it("shows retry {N} · cd {s}s badge during cooldown with retryAttempt", async () => {
    const c = makeCapture({
      id: 1,
      state: "cooling_down",
      retryAttempt: 1,
      cooldownEndsAt: Date.now() + 5000,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText(/retry 1 · cd \d+s/)).toBeInTheDocument();
  });

  it("shows cooldown {s}s badge (fallback) during cooldown without retryAttempt", async () => {
    const c = makeCapture({
      id: 1,
      state: "cooling_down",
      cooldownEndsAt: Date.now() + 5000,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText(/cooldown \d+s/)).toBeInTheDocument();
  });

  it("shows retry {N} · {threshold}s badge during streaming retry with threshold", async () => {
    const c = makeCapture({
      id: 1,
      state: "streaming",
      retryAttempt: 1,
      threshold: 60000,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText("retry 1 · 60s")).toBeInTheDocument();
  });

  it("shows retry {N} (no threshold) during streaming retry when threshold absent", async () => {
    const c = makeCapture({
      id: 1,
      state: "streaming",
      retryAttempt: 1,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText("retry 1")).toBeInTheDocument();
  });

  it("does NOT show running badge when streaming with retryAttempt > 0", async () => {
    const c = makeCapture({
      id: 1,
      state: "streaming",
      retryAttempt: 1,
      threshold: 30000,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.queryByText("running")).not.toBeInTheDocument();
  });
});

describe("CaptureRowItem row 4 — p50/tps/ratio", () => {
  it("renders row 4 when upstream_ttft_p50_ms is non-null", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 1500,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText(/p50: ttft 1\.0s/)).toBeInTheDocument();
    expect(screen.getByText(/p50: ttft 1\.0s 50\.0 t\/s/)).toBeInTheDocument();
    expect(screen.getByText("ttft 1.5x")).toBeInTheDocument();
  });

  it("does NOT render row 4 when upstream_ttft_p50_ms is null", async () => {
    const c = makeCapture({ id: 1, state: "done", upstream_ttft_p50_ms: null });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.queryByText(/^p50:/)).not.toBeInTheDocument();
  });

  it("omits t/s from p50 span when upstream_tps_p50 is null", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 800,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: null,
      tps: null,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText(/p50: ttft 1\.0s/)).toBeInTheDocument();
    expect(screen.queryByText(/p50: ttft.*t\/s/)).not.toBeInTheDocument();
  });

  it("includes t/s in p50 span when upstream_tps_p50 is non-null", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 800,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText(/p50: ttft 1\.0s 50\.0 t\/s/)).toBeInTheDocument();
  });

  it("renders ratio with muted color when ratio <= wm (default 5)", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 3000,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    const ratioEl = screen.getByText("ttft 3.0x");
    expect(ratioEl).toHaveClass("text-muted-foreground");
    expect(ratioEl).not.toHaveClass("text-amber-600");
    expect(ratioEl).not.toHaveClass("text-destructive");
  });

  it("renders ratio with amber color when ratio > wm and < wm*2 (default 5–10)", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 7500,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    const ratioEl = screen.getByText("ttft 7.5x");
    expect(ratioEl).toHaveClass("text-amber-600");
    expect(ratioEl).not.toHaveClass("text-destructive");
  });

  it("renders ratio with destructive color when ratio >= wm*2 (default >=10)", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 20000,
      upstream_ttft_p50_ms: 2000,
      upstream_tps_p50: 50,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    const ratioEl = screen.getByText("ttft 10.0x");
    expect(ratioEl).toHaveClass("text-destructive");
  });

  it("renders ratio with muted color at ratio = wm (boundary, default 5)", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 5000,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    const ratioEl = screen.getByText("ttft 5.0x");
    expect(ratioEl).toHaveClass("text-muted-foreground");
    expect(ratioEl).not.toHaveClass("text-amber-600");
  });

  it("renders ratio with destructive color at ratio = wm*2 (boundary, default 10)", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 10000,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    const ratioEl = screen.getByText("ttft 10.0x");
    expect(ratioEl).toHaveClass("text-destructive");
  });

  it("uses watchdogMultiplier prop for thresholds when provided", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 6000,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
        watchdogMultiplier={3}
      />,
    );
    await flushEffects();

    const ratioEl = screen.getByText("ttft 6.0x");
    expect(ratioEl).toHaveClass("text-destructive");
  });

  it("defaults to wm=5 when watchdogMultiplier is undefined", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 4000,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    const ratioEl = screen.getByText("ttft 4.0x");
    expect(ratioEl).toHaveClass("text-muted-foreground");
  });

  it("omits ratio when capture ttft_ms is null", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: null,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.queryByText(/ttft \d\.\dx/)).not.toBeInTheDocument();
    expect(screen.getByText(/p50: ttft 1\.0s/)).toBeInTheDocument();
  });

  it("renders /v1/status + status combined label at start of row 4", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 1500,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
      path: "/v1/messages",
      response_status: 200,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    expect(screen.getByText("/v1/status 200")).toBeInTheDocument();
  });

  it("renders /v1/status without status when response_status is null", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 1500,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: 50,
      path: "/v1/messages",
      response_status: null,
    });
    render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );
    await flushEffects();

    // Row 4 path span has class "text-muted-foreground/70" (Row 2 path is "text-foreground/80")
    const row4Spans = screen.getAllByText("/v1/status");
    const row4Path = row4Spans.find((el) => el.className.includes("text-muted-foreground/70"));
    expect(row4Path).toBeDefined();
    expect(screen.queryByText("/v1/status null")).not.toBeInTheDocument();
  });
});

describe("CaptureRowItem cooldown countdown — stale-now on state transition", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      shouldAdvanceTime: false,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows accurate countdown when transitioning streaming→cooling_down after delay", async () => {
    const T0 = 1_700_000_000_000;
    vi.setSystemTime(T0);

    const c = makeCapture({ id: 1, state: "streaming", started_at: T0 });
    const { rerender } = render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );

    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.queryByText(/cd \d+s/)).not.toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    vi.setSystemTime(T0 + 3000);
    const updated = makeCapture({
      ...c,
      state: "cooling_down",
      retryAttempt: 1,
      cooldownEndsAt: T0 + 3000 + 5000,
    });
    await act(async () => {
      rerender(
        <CaptureRowItem
          capture={updated}
          selected={false}
          isActive={false}
          optionId="opt-1"
          onActivate={vi.fn()}
        />,
      );
    });

    expect(screen.getByText("retry 1 · cd 5s")).toBeInTheDocument();
  });

  it("cooldown badge (no retry) shows accurate countdown after streaming→cooling_down transition", async () => {
    const T0 = 1_700_000_000_000;
    vi.setSystemTime(T0);

    const c = makeCapture({ id: 1, state: "streaming", started_at: T0 });
    const { rerender } = render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );

    expect(screen.getByText("running")).toBeInTheDocument();

    await act(async () => {
      vi.advanceTimersByTime(3000);
    });

    vi.setSystemTime(T0 + 3000);
    const updated = makeCapture({
      ...c,
      state: "cooling_down",
      retryAttempt: 0,
      cooldownEndsAt: T0 + 3000 + 5000,
    });
    await act(async () => {
      rerender(
        <CaptureRowItem
          capture={updated}
          selected={false}
          isActive={false}
          optionId="opt-1"
          onActivate={vi.fn()}
        />,
      );
    });

    expect(screen.getByText("cooldown 5s")).toBeInTheDocument();
  });

  it("useLiveAge shows accurate age when transitioning done→streaming after delay", async () => {
    const T0 = 1_700_000_000_000;
    vi.setSystemTime(T0);

    const c = makeCapture({ id: 1, state: "done", started_at: T0, duration_ms: 100 });
    const { rerender } = render(
      <CaptureRowItem
        capture={c}
        selected={false}
        isActive={false}
        optionId="opt-1"
        onActivate={vi.fn()}
      />,
    );

    expect(screen.queryByText("0s")).not.toBeInTheDocument();

    vi.setSystemTime(T0 + 3000);

    const updated = makeCapture({
      ...c,
      state: "streaming",
      started_at: T0,
      duration_ms: null,
    });
    await act(async () => {
      rerender(
        <CaptureRowItem
          capture={updated}
          selected={false}
          isActive={false}
          optionId="opt-1"
          onActivate={vi.fn()}
        />,
      );
    });

    expect(screen.getByText("3s")).toBeInTheDocument();
  });
});
