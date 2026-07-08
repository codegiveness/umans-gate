import type { OpenAiBody } from "./types.js";

export interface StampReasoningOptions {
  reasoningEffort: "high" | "max" | null | undefined;
}

/**
 * Stamp OpenAI-compatible request body with reasoning_effort and strip any
 * conflicting max_tokens/thinking fields. Mutates the body in place.
 * Returns true if the body was changed.
 *
 * When reasoning_effort is disabled (null/undefined), the key is removed from
 * the body rather than left as an explicit undefined value.
 */
export function stampReasoning(body: OpenAiBody, options: StampReasoningOptions): boolean {
  let changed = false;

  if (body.max_tokens !== undefined) {
    body.max_tokens = undefined;
    changed = true;
  }
  if (body.thinking !== undefined) {
    body.thinking = undefined;
    changed = true;
  }

  if (options.reasoningEffort === null || options.reasoningEffort === undefined) {
    if (Object.prototype.hasOwnProperty.call(body, "reasoning_effort")) {
      Reflect.deleteProperty(body, "reasoning_effort");
      changed = true;
    }
  } else if (body.reasoning_effort !== options.reasoningEffort) {
    body.reasoning_effort = options.reasoningEffort;
    changed = true;
  }

  return changed;
}
