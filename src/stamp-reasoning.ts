import type { OpenAiBody } from "./types.js";

export interface StampReasoningOptions {
  reasoningEffort: "high" | "max" | null | undefined;
}

/**
 * Respect-if-present semantics (ADR-0008): never inject, strip, or overwrite
 * `reasoning_effort`, `max_tokens`, or `thinking` on OpenAI request bodies.
 * The function is a no-op that preserves the pipeline structure and the
 * `stampReasoningEffort` toggle's gating role. Always returns false.
 */
export function stampReasoning(_body: OpenAiBody, _options: StampReasoningOptions): boolean {
  return false;
}
