import {
  STAMP_MAX_TOKENS_GLM_VALUE,
  STAMP_MAX_TOKENS_VALUE,
  STAMP_OUTPUT_CONFIG_GLM_VALUE,
  STAMP_OUTPUT_CONFIG_VALUE,
} from "./config.js";
import { isGlmModel } from "./model-policy.js";
import { extractModelName } from "./models/name.js";
import type { AnthropicBody, OutputConfig, ThinkingConfig } from "./types.js";

const DEFAULT_THINKING: ThinkingConfig = {
  type: "adaptive",
};

export interface StampOptions {
  /** Inject `max_tokens` resolved from model (131071 for GLM, 32767 for others) when true. */
  maxTokens?: boolean;
  /** Inject `thinking` block when true. */
  thinking?: ThinkingConfig | boolean;
  /** Inject `output_config` block when true. */
  outputConfig?: OutputConfig | boolean;
}

function modelMatchesThinkingPattern(model: unknown): boolean {
  if (typeof model !== "string") return false;
  if (model === "umans-coder" || model === "umans-flash") return true;
  return model.startsWith("umans-kimi") || model.startsWith("umans-qwen");
}

function resolveOutputConfig(model: unknown, outputConfig: OutputConfig | boolean): OutputConfig {
  if (typeof outputConfig === "object" && outputConfig !== null) return outputConfig;
  if (typeof model === "string" && isGlmModel(model)) return STAMP_OUTPUT_CONFIG_GLM_VALUE;
  return STAMP_OUTPUT_CONFIG_VALUE;
}

function resolveMaxTokens(model: unknown): number {
  if (typeof model === "string" && isGlmModel(model)) return STAMP_MAX_TOKENS_GLM_VALUE;
  return STAMP_MAX_TOKENS_VALUE;
}

/**
 * Stamp Anthropic request body fields based on enabled toggles. Overwrites any
 * existing values. Mutates the body in place. Returns true if the body was changed.
 */
export function stampThinking(body: AnthropicBody, options: StampOptions): boolean {
  const model = extractModelName(body);
  let changed = false;

  if (options.maxTokens) {
    body.max_tokens = resolveMaxTokens(model);
    changed = true;
  }

  if (options.thinking) {
    if (modelMatchesThinkingPattern(model)) {
      body.thinking = typeof options.thinking === "object" ? options.thinking : DEFAULT_THINKING;
      changed = true;
    }
  }

  if (options.outputConfig) {
    body.output_config = resolveOutputConfig(model, options.outputConfig);
    changed = true;
  }

  return changed;
}
