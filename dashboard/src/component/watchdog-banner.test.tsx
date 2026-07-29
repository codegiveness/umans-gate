import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { WatchdogBanner } from "@/components/watchdog-banner";

describe("WatchdogBanner", () => {
  it("renders banner when watchdogDisabled is true", () => {
    const { container } = render(
      <WatchdogBanner watchdogDisabled={true} consecutiveFailures={3} onDismiss={vi.fn()} />,
    );
    expect(container).toHaveTextContent("TTFT watchdog auto-disabled");
    expect(container).toHaveTextContent("Reload config to re-enable");
  });

  it("does not render when watchdogDisabled is false", () => {
    const { container } = render(
      <WatchdogBanner watchdogDisabled={false} consecutiveFailures={0} onDismiss={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("calls onDismiss when dismiss button clicked", () => {
    const onDismiss = vi.fn();
    const { getByLabelText } = render(
      <WatchdogBanner watchdogDisabled={true} consecutiveFailures={3} onDismiss={onDismiss} />,
    );
    fireEvent.click(getByLabelText("Dismiss watchdog banner"));
    expect(onDismiss).toHaveBeenCalledOnce();
  });

  it("shows the consecutive failure count in the text", () => {
    const { container } = render(
      <WatchdogBanner watchdogDisabled={true} consecutiveFailures={5} onDismiss={vi.fn()} />,
    );
    expect(container).toHaveTextContent("after 5 consecutive retry failures");
  });
});
