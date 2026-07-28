// Unit tests for src/vision/triage.ts — every decision branch + determinism + defaults.
import { expect, test } from "bun:test";
import {
  DEFAULT_TRIAGE_CONFIG,
  type TriageConfig,
  type TriageInput,
  triageVision,
} from "../../src/vision/triage.js";

const cfg: TriageConfig = DEFAULT_TRIAGE_CONFIG;

function mk(partial: Partial<TriageInput>): TriageInput {
  return { adjacentText: undefined, isToolResult: false, imageCount: 1, ...partial };
}

// 1. Tool-result image → "generic" regardless of text.
test("tool-result image routes to generic even with rich text", () => {
  expect(
    triageVision(
      mk({ isToolResult: true, adjacentText: "compare this with the previous run", imageCount: 2 }),
      cfg,
    ),
  ).toBe("generic");
});

test("tool-result image routes to generic even with no text", () => {
  expect(triageVision(mk({ isToolResult: true, imageCount: 1 }), cfg)).toBe("generic");
});

// 2. No adjacent text (undefined) → generic.
test("undefined adjacent text routes to generic", () => {
  expect(triageVision(mk({ adjacentText: undefined, imageCount: 1 }), cfg)).toBe("generic");
});

// 3. Empty / whitespace adjacent text → generic.
test("empty adjacent text routes to generic", () => {
  expect(triageVision(mk({ adjacentText: "", imageCount: 1 }), cfg)).toBe("generic");
});

test("whitespace-only adjacent text routes to generic", () => {
  expect(triageVision(mk({ adjacentText: "   \n\t  ", imageCount: 1 }), cfg)).toBe("generic");
});

// 4. Generic phrasing.
test('"describe this" routes to generic', () => {
  expect(triageVision(mk({ adjacentText: "describe this", imageCount: 1 }), cfg)).toBe("generic");
});

test('"what\'s in this image?" routes to generic', () => {
  expect(triageVision(mk({ adjacentText: "what's in this image?", imageCount: 1 }), cfg)).toBe(
    "generic",
  );
});

test('"what do you see" routes to generic', () => {
  expect(triageVision(mk({ adjacentText: "what do you see", imageCount: 1 }), cfg)).toBe("generic");
});

test('"what is this" routes to generic', () => {
  expect(triageVision(mk({ adjacentText: "what is this", imageCount: 1 }), cfg)).toBe("generic");
});

test('"can you see the diagram" routes to generic', () => {
  expect(triageVision(mk({ adjacentText: "can you see the diagram", imageCount: 1 }), cfg)).toBe(
    "generic",
  );
});

// 5. Multi-image + comparative → generic.
test("multi-image + 'which is brighter?' routes to generic", () => {
  expect(triageVision(mk({ adjacentText: "which is brighter?", imageCount: 2 }), cfg)).toBe(
    "generic",
  );
});

test("multi-image + 'compare' routes to generic", () => {
  expect(triageVision(mk({ adjacentText: "compare the two charts", imageCount: 2 }), cfg)).toBe(
    "generic",
  );
});

// 6. Multi-image + image reference → decomposed.
test("multi-image + 'see red on image A' routes to decomposed", () => {
  expect(triageVision(mk({ adjacentText: "see red on image A", imageCount: 2 }), cfg)).toBe(
    "decomposed",
  );
});

// 7. Multi-image + positional reference → decomposed.
test("multi-image + 'see the first one' routes to decomposed", () => {
  expect(triageVision(mk({ adjacentText: "see the first one", imageCount: 2 }), cfg)).toBe(
    "decomposed",
  );
});

test("multi-image + 'see the second image' routes to decomposed", () => {
  expect(triageVision(mk({ adjacentText: "see the second image", imageCount: 2 }), cfg)).toBe(
    "decomposed",
  );
});

test("multi-image + 'image 1' routes to decomposed", () => {
  expect(triageVision(mk({ adjacentText: "look at image 1", imageCount: 2 }), cfg)).toBe(
    "decomposed",
  );
});

// 8. Multi-image + no references → slotted.
// NOTE: plan suggested "describe these charts" but that matches the generic-phrasing
// rule (starts with "describe") per the decision tree. Use a neutral multi-image prompt
// that doesn't trip rule 3, comparative terms, or image-reference patterns.
test("multi-image + neutral prompt routes to slotted", () => {
  expect(
    triageVision(mk({ adjacentText: "explain the trends shown here", imageCount: 3 }), cfg),
  ).toBe("slotted");
});

// 9. Single-image + relational term → crafted.
test("single-image + 'is this consistent with the pattern?' routes to crafted", () => {
  expect(
    triageVision(mk({ adjacentText: "is this consistent with the pattern?", imageCount: 1 }), cfg),
  ).toBe("crafted");
});

test("single-image + 'compare' (relational) routes to crafted", () => {
  expect(triageVision(mk({ adjacentText: "compare with the reference", imageCount: 1 }), cfg)).toBe(
    "crafted",
  );
});

// 10. Single-image + long specific question (>40 chars, no relational) → crafted.
test("single-image + long specific question routes to crafted", () => {
  const longQ = "please identify the make and model of the car shown in this photo";
  expect(longQ.length).toBeGreaterThan(40);
  expect(triageVision(mk({ adjacentText: longQ, imageCount: 1 }), cfg)).toBe("crafted");
});

// 11. Single-image + short specific question → slotted.
test("single-image + short specific question routes to slotted", () => {
  expect(triageVision(mk({ adjacentText: "what color is the sky?", imageCount: 1 }), cfg)).toBe(
    "slotted",
  );
});

// 12. Determinism: same input twice → same output.
test("triageVision is deterministic", () => {
  const input = mk({ adjacentText: "describe these charts", imageCount: 2 });
  const a = triageVision(input, cfg);
  const b = triageVision(input, cfg);
  expect(a).toBe(b);
});

test("triageVision is deterministic across constructed-equal inputs", () => {
  const i1 = mk({ adjacentText: "see red on image A", imageCount: 2 });
  const i2 = mk({ adjacentText: "see red on image A", imageCount: 2 });
  expect(triageVision(i1, cfg)).toBe(triageVision(i2, cfg));
});

// 13. Default config has the expected values.
test("DEFAULT_TRIAGE_CONFIG has minSpecificLength 40", () => {
  expect(DEFAULT_TRIAGE_CONFIG.minSpecificLength).toBe(40);
});

test("DEFAULT_TRIAGE_CONFIG relationalTerms contains expected entries", () => {
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toContain("compare");
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toContain("contrast");
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toContain("same as");
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toContain("different from");
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toContain("before");
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toContain("after");
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toContain("previous");
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toContain("earlier");
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toContain("consistent with");
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toContain("match");
  expect(DEFAULT_TRIAGE_CONFIG.relationalTerms).toHaveLength(10);
});

test("DEFAULT_TRIAGE_CONFIG comparativeTerms contains expected entries", () => {
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toContain("compare");
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toContain("contrast");
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toContain("which is");
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toContain("which has");
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toContain("brighter");
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toContain("darker");
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toContain("larger");
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toContain("smaller");
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toContain("the same");
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toContain("different between");
  expect(DEFAULT_TRIAGE_CONFIG.comparativeTerms).toHaveLength(10);
});

test("DEFAULT_TRIAGE_CONFIG imageReferencePatterns has 4 patterns", () => {
  expect(DEFAULT_TRIAGE_CONFIG.imageReferencePatterns).toHaveLength(4);
});

// 14. Boundary: text exactly at minSpecificLength (40) does NOT trigger crafted (uses >).
test("single-image text exactly at minSpecificLength (40 chars, no relational) routes to slotted", () => {
  const exact = "a".repeat(40); // 40 chars, no relational term
  expect(exact.length).toBe(40);
  expect(triageVision(mk({ adjacentText: exact, imageCount: 1 }), cfg)).toBe("slotted");
});

test("single-image text at 41 chars (no relational) routes to crafted", () => {
  const just = "a".repeat(41);
  expect(just.length).toBe(41);
  expect(triageVision(mk({ adjacentText: just, imageCount: 1 }), cfg)).toBe("crafted");
});
