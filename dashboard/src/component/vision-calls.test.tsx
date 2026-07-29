import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

import { VisionCalls } from "@/components/vision-calls";
import { flushEffects } from "@/test/utils";
import type { VisionCallRecord } from "@/types/vision";

// Mock the tooltip so content renders inline (jsdom doesn't support portals well).
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

// vi.mock is hoisted above the test body, so we use a hoisted holder to pass
// per-test records into the mocked hook.
const holder = vi.hoisted(() => ({ records: [] as VisionCallRecord[] }));

vi.mock("@/hooks/use-vision-calls", () => ({
  useVisionCalls: () => ({
    records: holder.records,
    loading: false,
    error: null,
    refresh: () => {},
    clear: () => {},
  }),
}));

vi.mock("@/hooks/use-config-context", () => ({
  useConfigContext: () => ({ config: { vision_cache_ttl_ms: 604800000 } }),
}));

function makeRecord(overrides: Partial<VisionCallRecord> = {}): VisionCallRecord {
  return {
    id: 1,
    captureId: null,
    model: "umans-flash",
    target: "gpt-4o",
    imageSize: 1024,
    imageHash: "abc123",
    status: "ok",
    httpStatus: 200,
    latencyMs: 500,
    description: "",
    error: null,
    timestamp: Date.now(),
    incoming_protocol: "http1.1",
    upstream_protocol: "http1.1",
    state: "done",
    ...overrides,
  };
}

describe("VisionCalls description ScrollArea viewport", () => {
  it("bounds the description viewport with max-h-40 for long descriptions", async () => {
    const longDescription = "x".repeat(2000);
    holder.records = [makeRecord({ description: longDescription })];

    render(<VisionCalls />);
    await flushEffects();

    const viewport = screen
      .getByText(longDescription)
      .closest('[data-slot="scroll-area-viewport"]');
    expect(viewport).not.toBeNull();
    expect(viewport?.className).toContain("max-h-40");
  });

  it("also applies max-h-40 to the viewport for short descriptions", async () => {
    holder.records = [makeRecord({ description: "short description" })];

    render(<VisionCalls />);
    await flushEffects();

    const viewport = screen
      .getByText("short description")
      .closest('[data-slot="scroll-area-viewport"]');
    expect(viewport).not.toBeNull();
    expect(viewport?.className).toContain("max-h-40");
  });
});
