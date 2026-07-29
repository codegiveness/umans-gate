import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { BodyRenderer } from "@/components/body-renderer";
import { flushEffects } from "@/test/utils";

// Mock heavy child viewers so lazy resolution is deterministic and the test
// stays focused on BodyRenderer's own rendering branches.
vi.mock("@/components/json-viewer", () => ({
  JsonViewer: ({ body }: { body: string | null }) => (
    <div data-testid="json-viewer">{body ?? "null"}</div>
  ),
}));

vi.mock("@/components/sse-viewer", () => ({
  SseViewer: ({ body }: { body: string | null }) => (
    <div data-testid="sse-viewer">{body ?? "null"}</div>
  ),
}));

describe("BodyRenderer", () => {
  describe("null body", () => {
    it.each(["enqueued", "streaming", "cooling_down"] as const)(
      "renders streaming placeholder when state is %s and body is null",
      (state) => {
        render(<BodyRenderer body={null} isSse={false} state={state} />);

        expect(screen.getByText("Response still streaming…")).toBeInTheDocument();
        expect(screen.getByRole("img", { name: /loading/i })).toBeInTheDocument();
        expect(screen.queryByText("Response body not captured")).not.toBeInTheDocument();
        expect(screen.queryByText(/corrupted/)).not.toBeInTheDocument();
      },
    );

    it("renders not-captured placeholder when state is done and body is null", () => {
      const { container } = render(<BodyRenderer body={null} isSse={false} state="done" />);

      expect(screen.getByText("Response body not captured")).toBeInTheDocument();
      expect(screen.queryByText("Response still streaming…")).not.toBeInTheDocument();
      expect(screen.queryByText(/corrupted/)).not.toBeInTheDocument();

      const wrapper = container.querySelector("div");
      expect(wrapper?.className).not.toContain("text-destructive");
      expect(wrapper?.className).toContain("text-muted-foreground");
    });

    it("renders not-captured placeholder when state is undefined (backward-compatible default)", () => {
      render(<BodyRenderer body={null} isSse={false} />);

      expect(screen.getByText("Response body not captured")).toBeInTheDocument();
      expect(screen.queryByText("Response still streaming…")).not.toBeInTheDocument();
      expect(screen.queryByText(/corrupted/)).not.toBeInTheDocument();
    });
  });

  describe("unchanged rendering paths", () => {
    it("renders empty body placeholder when body is empty string", () => {
      render(<BodyRenderer body="" isSse={false} state="done" />);

      expect(screen.getByText("empty body")).toBeInTheDocument();
      expect(screen.queryByText("Response body not captured")).not.toBeInTheDocument();
    });

    it("renders binary placeholder when body is base64-encoded", () => {
      render(<BodyRenderer body="__B64__aGVsbG8=" isSse={false} state="done" />);

      expect(screen.getByText(/binary data \(base64,/)).toBeInTheDocument();
      expect(screen.queryByText("Response body not captured")).not.toBeInTheDocument();
    });

    it("renders SseViewer when isSse is true", async () => {
      const body = "data: hello\n\n";
      render(<BodyRenderer body={body} isSse={true} state="done" />);
      await flushEffects();

      expect(screen.getByTestId("sse-viewer")).toBeInTheDocument();
    });

    it("renders JsonViewer when body is valid JSON", async () => {
      const body = '{"key":"value"}';
      render(<BodyRenderer body={body} isSse={false} state="done" />);
      await flushEffects();

      expect(screen.getByTestId("json-viewer")).toBeInTheDocument();
    });

    it("renders plain text in a pre block when body is not JSON", () => {
      const body = "just plain text";
      render(<BodyRenderer body={body} isSse={false} state="done" />);

      const pre = document.querySelector("pre");
      expect(pre).not.toBeNull();
      expect(pre?.textContent).toBe("just plain text");
      expect(screen.queryByTestId("json-viewer")).not.toBeInTheDocument();
    });
  });
});
