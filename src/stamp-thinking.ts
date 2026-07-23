import { extractModelName } from "./models/name.js";
import { matchStampOverlay, type StampPolicy } from "./stamp-catalog.js";
import type { AnthropicBody, OutputConfig } from "./types.js";

export interface StampOptions {
  /** Inject `max_tokens` resolved from policy when true. */
  maxTokens?: boolean;
  /** Inject `output_config` block when true AND the body already has thinking enabled. */
  outputConfig?: OutputConfig | boolean;
  /**
   * Resolved stamp policy. When omitted, the policy is resolved from the
   * body's `model` field via the local overlay (kept for unit-test
   * ergonomics — the pipeline always supplies this).
   */
  policy?: StampPolicy;
}

function isThinkingEnabled(body: AnthropicBody): boolean {
  if (!body.thinking) return false;
  if (typeof body.thinking === "object" && (body.thinking as { type?: string }).type === "disabled")
    return false;
  return true;
}

/**
 * Stamp Anthropic request body fields based on enabled toggles.
 *
 * Respect-if-present semantics (ADR-0008):
 * - `max_tokens`: always stamped from policy when `options.maxTokens` is true.
 * - `thinking`: never injected or overwritten. An existing `thinking` field
 *   (including `{ type: "disabled" }`) is always left untouched.
 * - `output_config`: injected only when `options.outputConfig` is truthy AND
 *   the body already has `thinking` enabled (present and not `{ type: "disabled" }`).
 *
 * Mutates the body in place. Returns true if the body was changed.
 */
export function stampThinking(body: AnthropicBody, options: StampOptions): boolean {
  const model = extractModelName(body);
  const policy = options.policy ?? matchStampOverlay(typeof model === "string" ? model : "");
  let changed = false;

  if (options.maxTokens) {
    body.max_tokens = policy.max_tokens;
    changed = true;
  }

  if (options.outputConfig && isThinkingEnabled(body) && policy.thinking) {
    body.output_config =
      typeof options.outputConfig === "object" && options.outputConfig !== null
        ? options.outputConfig
        : { effort: policy.effort };
    changed = true;
  }

  return changed;
}
