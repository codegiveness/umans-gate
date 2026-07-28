import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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

    expect(screen.getByText(/p50 1\.0s/)).toBeInTheDocument();
    expect(screen.getByText("50.0 t/s")).toBeInTheDocument();
    expect(screen.getByText("1.5x")).toBeInTheDocument();
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

    expect(screen.queryByText(/^p50/)).not.toBeInTheDocument();
  });

  it("shows ~ prefix on p50 when upstream_tps_p50 is null (overall p50 used)", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 800,
      upstream_ttft_p50_ms: 1000,
      upstream_tps_p50: null,
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

    expect(screen.getByText(/~1\.0s/)).toBeInTheDocument();
  });

  it("does NOT show ~ prefix when upstream_tps_p50 is non-null", async () => {
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

    expect(screen.getByText(/p50 1\.0s/)).toBeInTheDocument();
    expect(screen.queryByText(/~1\.0s/)).not.toBeInTheDocument();
  });

  it("renders ratio with amber color when ratio > 1.5x", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 1600,
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

    const ratioEl = screen.getByText("1.6x");
    expect(ratioEl).toHaveClass("text-amber-600");
    expect(ratioEl).not.toHaveClass("text-destructive");
  });

  it("renders ratio with red color when ratio > 2x", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 2500,
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

    const ratioEl = screen.getByText("2.5x");
    expect(ratioEl).toHaveClass("text-destructive");
  });

  it("renders ratio with muted color when ratio <= 1.5x", async () => {
    const c = makeCapture({
      id: 1,
      state: "done",
      ttft_ms: 1200,
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

    const ratioEl = screen.getByText("1.2x");
    expect(ratioEl).toHaveClass("text-muted-foreground");
    expect(ratioEl).not.toHaveClass("text-amber-600");
    expect(ratioEl).not.toHaveClass("text-destructive");
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

    expect(screen.queryByText(/\d\.\dx/)).not.toBeInTheDocument();
    expect(screen.getByText(/p50 1\.0s/)).toBeInTheDocument();
  });
});
