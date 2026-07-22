import { extractModelName } from "./models/name.js";
import { type StampPolicy, matchStampOverlay } from "./stamp-catalog.js";
import type { AnthropicBody, OutputConfig, ThinkingConfig } from "./types.js";

const DEFAULT_THINKING: ThinkingConfig = {
  type: "adaptive",
};

export interface StampOptions {
  /** Inject `max_tokens` resolved from policy when true. */
  maxTokens?: boolean;
  /** Inject `thinking` block when policy allows it. */
  thinking?: ThinkingConfig | boolean;
  /** Inject `output_config` block when true. */
  outputConfig?: OutputConfig | boolean;
  /**
   * Resolved stamp policy. When omitted, the policy is resolved from the
   * body's `model` field via the local overlay (kept for unit-test
   * ergonomics — the pipeline always supplies this).
   */
  policy?: StampPolicy;
}

/**
 * Stamp Anthropic request body fields based on enabled toggles. Overwrites any
 * existing values. Mutates the body in place. Returns true if the body was changed.
 */
export function stampThinking(body: AnthropicBody, options: StampOptions): boolean {
  const model = extractModelName(body);
  const policy = options.policy ?? matchStampOverlay(typeof model === "string" ? model : "");
  let changed = false;

  if (options.maxTokens) {
    body.max_tokens = policy.max_tokens;
    changed = true;
  }

  if (options.thinking) {
    if (policy.thinking) {
      body.thinking = typeof options.thinking === "object" ? options.thinking : DEFAULT_THINKING;
      changed = true;
    }
  }

  if (options.outputConfig) {
    body.output_config =
      typeof options.outputConfig === "object" && options.outputConfig !== null
        ? options.outputConfig
        : { effort: policy.effort };
    changed = true;
  }

  return changed;
}
