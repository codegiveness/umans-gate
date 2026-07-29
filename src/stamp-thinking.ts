import { extractModelName } from "./models/name.js";
import { matchStampOverlay, type StampPolicy } from "./stamp-catalog.js";
import type { AnthropicBody, OutputConfig, ThinkingConfig } from "./types.js";

export interface StampOptions {
  /** Inject `max_tokens` resolved from policy when true. */
  maxTokens?: boolean;
  /** Inject `output_config` block when true AND the body already has thinking enabled. */
  outputConfig?: OutputConfig | boolean;
  /**
   * Force `thinking` to the proxy's adaptive config when true AND the body
   * already has a non-disabled thinking block. Disabled forms
   * (`type: "disabled"`, `type: "off"`, `type: "none"`, `enabled: false`)
   * are always respected; any other thinking shape is overwritten.
   */
  thinking?: boolean;
  /**
   * Resolved stamp policy. When omitted, the policy is resolved from the
   * body's `model` field via the local overlay (kept for unit-test
   * ergonomics — the pipeline always supplies this).
   */
  policy?: StampPolicy;
}

/** Thinking `type` values that signal an explicitly-disabled thinking block. */
const DISABLED_THINKING_TYPES = new Set(["disabled", "off", "none"]);

/**
 * Whether `body.thinking` is explicitly disabled — either via a known
 * `type` sentinel (`"disabled"`, `"off"`, `"none"`) or an `enabled: false`
 * flag. Such blocks must always be respected, never forced or stripped.
 */
export function isThinkingDisabled(thinking: unknown): boolean {
  if (thinking == null || typeof thinking !== "object") return false;
  const t = thinking as { type?: string; enabled?: unknown };
  if (typeof t.type === "string" && DISABLED_THINKING_TYPES.has(t.type.toLowerCase())) return true;
  if (t.enabled === false) return true;
  return false;
}

/**
 * Whether `body.thinking` is present and enabled (i.e. not absent and not
 * explicitly disabled). Used to gate `output_config` and `temperature`
 * stamping.
 */
export function isThinkingEnabled(thinking: unknown): boolean {
  if (thinking == null) return false;
  if (isThinkingDisabled(thinking)) return false;
  return true;
}

/**
 * Structural equality between two `ThinkingConfig` values. Used to skip
 * spurious writes when the body already carries the policy's thinking
 * shape. Compares only the discriminant fields (`type` and its variants'
 * companions); extra client-sent fields do not count as equal.
 */
function thinkingEquals(a: ThinkingConfig, b: ThinkingConfig): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "enabled" && b.type === "enabled") {
    if ("keep" in a && "keep" in b) return a.keep === b.keep;
    if ("clear_thinking" in a && "clear_thinking" in b)
      return a.clear_thinking === b.clear_thinking;
    return false;
  }
  return true;
}

/**
 * Stamp Anthropic request body fields based on enabled toggles.
 *
 * `thinking` forcing semantics (when `options.thinking` is true):
 * - Absent: never injected.
 * - Disabled form AND `policy.canDisableThinking` is true: respected.
 * - Disabled form AND `policy.canDisableThinking` is false: forced to
 *   `policy.thinkingShape` (e.g. Kimi K2.7 where reasoning cannot be disabled).
 * - Any other shape: forced to `policy.thinkingShape`.
 *
 * The per-family `thinkingShape` (ADR-0017) drives the forced value:
 * GLM → `{ type:"enabled", clear_thinking:false }`,
 * Kimi/Coder → `{ type:"enabled", keep:"all" }`,
 * others → `{ type:"adaptive" }`.
 *
 * `max_tokens` is stamped from policy when `options.maxTokens` is true.
 * `output_config` is injected when `options.outputConfig` is truthy AND
 * the body has thinking enabled (present and not disabled).
 *
 * Mutates the body in place. Returns true if the body was changed.
 */
export function stampThinking(body: AnthropicBody, options: StampOptions): boolean {
  const model = extractModelName(body);
  const policy = options.policy ?? matchStampOverlay(typeof model === "string" ? model : "");
  let changed = false;

  if (options.maxTokens && isThinkingEnabled(body.thinking)) {
    body.max_tokens = policy.max_tokens;
    changed = true;
  }

  if (options.thinking && body.thinking != null) {
    const disabled = isThinkingDisabled(body.thinking);
    const shouldForce = !disabled || !policy.canDisableThinking;
    if (shouldForce) {
      const current = body.thinking as ThinkingConfig;
      if (!thinkingEquals(current, policy.thinkingShape)) {
        body.thinking = { ...policy.thinkingShape };
        changed = true;
      }
    }
  }

  if (options.outputConfig && isThinkingEnabled(body.thinking) && policy.thinking) {
    body.output_config =
      typeof options.outputConfig === "object" && options.outputConfig !== null
        ? options.outputConfig
        : { effort: policy.effort };
    changed = true;
  }

  return changed;
}
