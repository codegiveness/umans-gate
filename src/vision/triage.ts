// Pure deterministic triage of vision requests into one of four strategies.
// No I/O, no async, no LLM calls. Same input + config → same output.
// This determinism is critical because the chosen strategy seeds the contextHash
// used as a cache key — any non-determinism here would fragment the cache.

/** Which vision strategy should handle this request. */
export type VisionStrategy = "generic" | "slotted" | "crafted" | "decomposed";

/** Inputs the triage function needs. Adjacent text is optional (e.g. tool-result images). */
export interface TriageInput {
  adjacentText?: string;
  isToolResult: boolean;
  imageCount: number;
}

/** Tunable knobs for the decision tree. */
export interface TriageConfig {
  /** Minimum adjacent text length (in characters) to consider it "specific". Default: 40. */
  minSpecificLength: number;
  /** Relational terms that trigger "crafted" (single-image). */
  relationalTerms: string[];
  /** Image reference patterns that trigger "decomposed" (multi-image). */
  imageReferencePatterns: RegExp[];
  /** Comparative terms that defer to generic (no decomposition). */
  comparativeTerms: string[];
}

/** Default config: sensible for the v1 routing policy. */
export const DEFAULT_TRIAGE_CONFIG: TriageConfig = {
  minSpecificLength: 40,
  relationalTerms: [
    "compare",
    "contrast",
    "same as",
    "different from",
    "before",
    "after",
    "previous",
    "earlier",
    "consistent with",
    "match",
  ],
  comparativeTerms: [
    "compare",
    "contrast",
    "which is",
    "which has",
    "brighter",
    "darker",
    "larger",
    "smaller",
    "the same",
    "different between",
  ],
  imageReferencePatterns: [
    /image\s+[a-z]/i,
    /image\s+\d/i,
    /the\s+(first|second|third|last)\s+(one|image)/i,
    /image\s+\d+/i,
  ],
};

const GENERIC_PHRASING = /^(describe|what.s in|what do you see|what is this|can you see)/i;

/**
 * Decide which vision strategy applies to this request.
 *
 * Decision tree (evaluated top-down; first match wins):
 *   1. tool-result image → "generic"
 *   2. no adjacent text (undefined / empty / whitespace) → "generic"
 *   3. generic phrasing ("describe", "what's in", ...) → "generic"
 *   4. multi-image:
 *      a. comparative terms present → "generic"
 *      b. image-reference patterns match → "decomposed"
 *      c. otherwise → "slotted"
 *   5. single-image:
 *      a. relational term present OR text longer than minSpecificLength → "crafted"
 *      b. otherwise → "slotted"
 */
export function triageVision(input: TriageInput, config: TriageConfig): VisionStrategy {
  // 1. Tool-result images are already labeled by the harness; no strategy needed.
  if (input.isToolResult) return "generic";

  // 2. Without adjacent text there's nothing to base a strategy on.
  const text = input.adjacentText;
  if (!text || text.trim().length === 0) return "generic";

  // 3. Generic phrasing → defer to the default vision prompt.
  if (GENERIC_PHRASING.test(text.trim())) return "generic";

  // 4. Multi-image routing.
  if (input.imageCount > 1) {
    const lower = text.toLowerCase();
    // a. Comparative questions defer to generic (v1 limitation: no cross-image decomposition).
    for (const term of config.comparativeTerms) {
      if (lower.includes(term.toLowerCase())) return "generic";
    }
    // b. Explicit image references → decompose and answer per-image.
    for (const pattern of config.imageReferencePatterns) {
      if (pattern.test(text)) return "decomposed";
    }
    // c. Multiple images but no specific references → slot each.
    return "slotted";
  }

  // 5. Single-image routing.
  const lower = text.toLowerCase();
  for (const term of config.relationalTerms) {
    if (lower.includes(term.toLowerCase())) return "crafted";
  }
  if (text.length > config.minSpecificLength) return "crafted";

  // 6. Default: a short, neutral single-image question.
  return "slotted";
}
