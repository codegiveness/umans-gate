import { render, screen } from "@testing-library/react";
import type React from "react";
import { describe, expect, it, vi } from "vitest";

import { ErrorBoundary } from "@/components/error-boundary";

function ThrowOnRender({ message }: { message: string }): React.ReactNode {
  throw new Error(message);
}

describe("ErrorBoundary", () => {
  it("renders children when no error", () => {
    render(
      <ErrorBoundary>
        <div>OK content</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText("OK content")).toBeInTheDocument();
  });

  it("renders default fallback with title and Reload button when child throws", () => {
    // Suppress the expected console.error from React's error boundary logging.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary>
        <ThrowOnRender message="kaboom" />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Something went wrong")).toBeInTheDocument();
    expect(screen.getByText("kaboom")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();

    spy.mockRestore();
  });

  it("calls window.location.reload when Reload button is clicked", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reloadMock = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload: reloadMock });

    render(
      <ErrorBoundary>
        <ThrowOnRender message="crash" />
      </ErrorBoundary>,
    );

    screen.getByRole("button", { name: "Reload" }).click();
    expect(reloadMock).toHaveBeenCalledOnce();

    vi.unstubAllGlobals();
    spy.mockRestore();
  });

  it("renders custom fallback when provided", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});

    render(
      <ErrorBoundary fallback={<div>Custom fallback</div>}>
        <ThrowOnRender message="oops" />
      </ErrorBoundary>,
    );

    expect(screen.getByText("Custom fallback")).toBeInTheDocument();
    expect(screen.queryByText("Something went wrong")).not.toBeInTheDocument();

    spy.mockRestore();
  });
});
