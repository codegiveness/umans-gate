import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ClearConfirmDialog } from "@/components/clear-confirm-dialog";

describe("ClearConfirmDialog", () => {
  it("renders title and description with count when open", () => {
    render(<ClearConfirmDialog open={true} onConfirm={vi.fn()} onClose={vi.fn()} count={42} />);

    expect(screen.getByText("Clear all captures?")).toBeInTheDocument();
    expect(screen.getByText(/Delete 42 captured requests\?/)).toBeInTheDocument();
  });

  it("uses singular form for count of 1", () => {
    render(<ClearConfirmDialog open={true} onConfirm={vi.fn()} onClose={vi.fn()} count={1} />);

    expect(screen.getByText(/Delete 1 captured request\?/)).toBeInTheDocument();
  });

  it("calls onConfirm and onClose when Clear is clicked", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(<ClearConfirmDialog open={true} onConfirm={onConfirm} onClose={onClose} count={5} />);

    await user.click(screen.getByRole("button", { name: "Clear" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Cancel is clicked without calling onConfirm", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(<ClearConfirmDialog open={true} onConfirm={onConfirm} onClose={onClose} count={3} />);

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("calls onClose when Escape is pressed", async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();

    render(<ClearConfirmDialog open={true} onConfirm={onConfirm} onClose={onClose} count={2} />);

    await user.keyboard("{Escape}");

    expect(onConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not render content when closed", () => {
    render(<ClearConfirmDialog open={false} onConfirm={vi.fn()} onClose={vi.fn()} count={0} />);

    expect(screen.queryByText("Clear all captures?")).not.toBeInTheDocument();
  });
});
