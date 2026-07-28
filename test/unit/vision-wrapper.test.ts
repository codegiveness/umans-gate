// Unit tests for src/vision/wrapper.ts — wrapDescription, failurePlaceholder, formatPolicy, applyMaxImagesPolicy.
// Folded from vision-quality.test.ts (wrapper parts) + research/strategy-A wrapper parts.

import { describe, expect, test } from "bun:test";
import type { ImagePart } from "../../src/vision/detect.js";
import {
  applyMaxImagesPolicy,
  failurePlaceholder,
  formatPolicy,
  isFailurePlaceholder,
  wrapDescription,
} from "../../src/vision/wrapper.js";

const LABEL =
  "[Image content — analyzed by vision module, shown as text because the active model cannot see images:]";

describe("wrapDescription fixed label", () => {
  test("takes single argument, includes label and description", () => {
    const w = wrapDescription("a cat");
    expect(w).toContain(LABEL);
    expect(w).toContain("a cat");
  });

  test("byte-identical for identical input", () => {
    expect(wrapDescription("desc A")).toBe(wrapDescription("desc A"));
  });

  test("has no position index", () => {
    const w = wrapDescription("test");
    expect(w).not.toMatch(/Image [0-9]+/);
  });

  test("has no dynamic metadata (no timestamp or req id)", () => {
    const w = wrapDescription("test");
    expect(w).not.toMatch(/\d{13}/);
    expect(w).not.toMatch(/req_[a-z0-9]+/i);
  });

  test("multiple calls produce identical labels", () => {
    const descs = ["first", "second", "third"];
    const wrapped = descs.map((d) => wrapDescription(d));
    for (const w of wrapped) {
      expect(w.startsWith(LABEL)).toBe(true);
    }
  });
});

describe("failurePlaceholder", () => {
  test("timeout reason includes timed-out text and detail", () => {
    const p = failurePlaceholder("timeout", "60s");
    expect(p).toContain("[Image analysis failed:");
    expect(p).toContain("timed out after 60s");
    expect(isFailurePlaceholder(p)).toBe(true);
  });

  test("http_status reason includes HTTP detail", () => {
    const p = failurePlaceholder("http_status", "500");
    expect(p).toContain("returned HTTP 500");
    expect(isFailurePlaceholder(p)).toBe(true);
  });

  test("parse reason includes unparseable text", () => {
    const p = failurePlaceholder("parse", "invalid JSON");
    expect(p).toContain("unparseable response");
    expect(isFailurePlaceholder(p)).toBe(true);
  });

  test("empty reason includes empty description text", () => {
    const p = failurePlaceholder("empty", "no content");
    expect(p).toContain("empty description");
    expect(isFailurePlaceholder(p)).toBe(true);
  });

  test("generic reason interpolates detail directly", () => {
    const p = failurePlaceholder("generic", "unknown error");
    expect(p).toContain("unknown error");
    expect(isFailurePlaceholder(p)).toBe(true);
  });

  test("aborted reason includes client-disconnected text", () => {
    const p = failurePlaceholder("aborted", "client disconnect");
    expect(p).toContain("client disconnected");
    expect(isFailurePlaceholder(p)).toBe(true);
  });
});

describe("isFailurePlaceholder", () => {
  test("true for placeholder string", () => {
    expect(isFailurePlaceholder("[Image analysis failed: timeout. ...]")).toBe(true);
  });

  test("false for normal description", () => {
    expect(isFailurePlaceholder("a red cat sitting on a mat")).toBe(false);
  });

  test("false for wrapped description", () => {
    expect(isFailurePlaceholder(wrapDescription("a red cat"))).toBe(false);
  });
});

describe("formatPolicy", () => {
  test("png -> pass", () => {
    expect(formatPolicy("png", "image/png")).toBe("pass");
  });

  test("jpg -> pass", () => {
    expect(formatPolicy("jpg", "image/jpeg")).toBe("pass");
  });

  test("jpeg -> pass", () => {
    expect(formatPolicy("jpeg", "image/jpeg")).toBe("pass");
  });

  test("webp -> pass", () => {
    expect(formatPolicy("webp", "image/webp")).toBe("pass");
  });

  test("gif -> pass", () => {
    expect(formatPolicy("gif", "image/gif")).toBe("pass");
  });

  test("bmp -> transcode", () => {
    expect(formatPolicy("bmp", "image/bmp")).toBe("transcode");
  });

  test("tiff -> transcode", () => {
    expect(formatPolicy("tiff", "image/tiff")).toBe("transcode");
  });

  test("tif -> transcode", () => {
    expect(formatPolicy("tif", "image/tiff")).toBe("transcode");
  });

  test("heic -> transcode", () => {
    expect(formatPolicy("heic", "image/heic")).toBe("transcode");
  });

  test("heif -> transcode", () => {
    expect(formatPolicy("heif", "image/heif")).toBe("transcode");
  });

  test("svg -> transcode", () => {
    expect(formatPolicy("svg", "image/svg+xml")).toBe("transcode");
  });

  test("unknown ext -> reject", () => {
    expect(formatPolicy("xyz", "application/octet-stream")).toBe("reject");
  });
});

describe("applyMaxImagesPolicy", () => {
  function makeParts(n: number): ImagePart[] {
    return Array.from({ length: n }, (_, i) => ({
      mediaType: "image/png",
      encoding: "base64" as const,
      data: `data-${i}`,
      isToolResult: false,
      positionInBatch: i + 1,
      batchSize: n,
    }));
  }

  test("maxImages >= parts length: keeps all, no overflow", () => {
    const parts = makeParts(3);
    const { kept, overflow } = applyMaxImagesPolicy(parts, 5);
    expect(kept).toHaveLength(3);
    expect(overflow).toHaveLength(0);
  });

  test("maxImages < parts length: keeps first N, overflows rest", () => {
    const parts = makeParts(5);
    const { kept, overflow } = applyMaxImagesPolicy(parts, 2);
    expect(kept).toHaveLength(2);
    expect(overflow).toHaveLength(3);
    expect(kept[0].data).toBe("data-0");
    expect(kept[1].data).toBe("data-1");
  });

  test("overflow entries contain 'Image omitted' text", () => {
    const parts = makeParts(4);
    const { overflow } = applyMaxImagesPolicy(parts, 1);
    expect(overflow).toHaveLength(3);
    for (const o of overflow) {
      expect(o).toContain("[Image omitted:");
    }
  });

  test("maxImages=0: all overflow", () => {
    const parts = makeParts(2);
    const { kept, overflow } = applyMaxImagesPolicy(parts, 0);
    expect(kept).toHaveLength(0);
    expect(overflow).toHaveLength(2);
  });

  test("empty parts: empty kept and overflow", () => {
    const { kept, overflow } = applyMaxImagesPolicy([], 5);
    expect(kept).toHaveLength(0);
    expect(overflow).toHaveLength(0);
  });
});
