import { extractModelName } from "./models/name.js";
import { matchStampOverlay, type StampPolicy } from "./stamp-catalog.js";
import { isThinkingDisabled } from "./stamp-thinking.js";
import type { OpenAiBody } from "./types.js";

export interface StampReasoningOptions {
  reasoningEffort: "high" | "max" | null | undefined;
  policy?: StampPolicy;
}

const DISABLED_EFFORT_VALUES = new Set(["off", "none", "null"]);

function isReasoningEffortDisabled(value: unknown): boolean {
  if (value == null) return true;
  if (typeof value === "string" && DISABLED_EFFORT_VALUES.has(value.toLowerCase())) return true;
  return false;
}

/**
 * Stamp OpenAI request body `reasoning_effort` field.
 *
 * Forcing semantics (when `options.reasoningEffort` is non-null):
 * - `reasoning_effort` absent + `thinking` absent: do nothing (respect absence).
 * - `reasoning_effort` absent + `thinking` enabled: inject `reasoning_effort`
 *   from policy (user sent thinking on an OpenAI route — give them the proper
 *   OpenAI reasoning field).
 * - `reasoning_effort` absent + `thinking` disabled: respect (leave alone).
 * - `reasoning_effort` present + disabled value (`off`/`none`/`null`) +
 *   `canDisableThinking: true`: respect.
 * - `reasoning_effort` present + disabled value +
 *   `canDisableThinking: false`: force to policy effort.
 * - `reasoning_effort` present + any other value: force to policy effort.
 *
 * When `reasoning_effort` is present or injected, Anthropic-specific fields
 * are stripped from the body: `thinking`, `output_config`,
 * `context_management`. These have no meaning on an OpenAI route.
 * `temperature` is forced to 1.0 — reasoning models reject temperature != 1.0.
 *
 * Mutates the body in place. Returns true if the body was changed.
 */
export function stampReasoning(body: OpenAiBody, options: StampReasoningOptions): boolean {
  if (options.reasoningEffort == null) return false;

  const model = extractModelName(body as { model?: unknown });
  const policy = options.policy ?? matchStampOverlay(typeof model === "string" ? model : "");
  const targetEffort = policy.effort;
  let changed = false;

  const hasReasoning = "reasoning_effort" in body && body.reasoning_effort !== undefined;
  const hasThinking = body.thinking !== undefined;

  if (!hasReasoning && !hasThinking) return false;

  let reasoningActive = false;

  if (!hasReasoning && hasThinking) {
    if (isThinkingDisabled(body.thinking)) return false;
    if (!policy.thinking) return false;
    body.reasoning_effort = targetEffort;
    changed = true;
    reasoningActive = true;
  } else if (hasReasoning) {
    const disabled = isReasoningEffortDisabled(body.reasoning_effort);
    if (disabled && policy.canDisableThinking) {
      return false;
    }
    body.reasoning_effort = targetEffort;
    changed = true;
    reasoningActive = true;
  }

  if (reasoningActive) {
    if (hasThinking) {
      delete body.thinking;
    }
    if ("output_config" in body) {
      delete body.output_config;
      changed = true;
    }
    if ("context_management" in body) {
      delete body.context_management;
      changed = true;
    }
    if (body.temperature !== 1.0) {
      body.temperature = 1.0;
      changed = true;
    }
  }

  return changed;
}
