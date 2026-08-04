// Catalog-driven stamp policy overlay (ADR-0006).
//
// Declares a `StampPolicy` per model family and exposes
// `resolveStampPolicy()` — the single lookup the stamp pipeline uses
// to resolve per-model tuning (max_tokens, effort, thinking, top_k).
// Complemented by user-configured `stamp_model_rules` (ADR-0020).

import type { ParsedModelInfo } from "./model-info-parser.js";
import type { PerModelRule, ThinkingConfig } from "./types.js";

/**
 * Stamp tuning for a single model family.
 *
 * - `max_tokens`: value injected when stamping is on (131071 for GLM, 32767 otherwise).
 * - `effort`: `output_config.effort` value ("max" for GLM, "high" for others).
 * - `thinking`: whether the `thinking` block is injected for this model.
 * - `top_k`: value injected after `model`, or `null` to skip top_k injection.
 * - `canDisableThinking`: whether a client-sent disabled thinking block
 *   (`type: "disabled"`, `type: "off"`, `type: "none"`, `enabled: false`)
 *   should be respected. When `false`, thinking is always forced
 *   even if the client tries to disable it (e.g. Kimi K2.7 where reasoning
 *   cannot be turned off). Overridden from `/v1/models/info` `reasoning.can_disable`
 *   at parse time.
 * - `thinkingShape`: the `ThinkingConfig` value forced on the body when
 *   `stampThinking` decides to overwrite `body.thinking` (thinking is
 *   enabled and not respected as disabled). All overlay entries
 *   currently use `{ type: "adaptive" }`; per-family preserved-thinking
 *   shapes are applied via user-configured `stamp_model_rules` (ADR-0020).
 */
export interface StampPolicy {
  max_tokens: number;
  effort: "high" | "max";
  thinking: boolean;
  top_k: number | null;
  canDisableThinking: boolean;
  thinkingShape: ThinkingConfig;
}

/**
 * Local overlay keyed by model family pattern (glob-style `*` suffix).
 * Patterns are matched in declaration order; the first match wins. The
 * `"*"` entry is the fallback for any model not matched above it.
 *
 * Values are proxy tuning — see ADR-0006 for why they are not derived
 * from `max_completion_tokens` / `reasoning.default_level`.
 */
export const STAMP_OVERLAY: Record<string, StampPolicy> = {
  "umans-glm*": {
    max_tokens: 131071,
    effort: "max",
    thinking: true,
    top_k: 20,
    canDisableThinking: true,
    thinkingShape: { type: "adaptive" },
  },
  "umans-coder": {
    max_tokens: 32767,
    effort: "high",
    thinking: true,
    top_k: null,
    canDisableThinking: false,
    thinkingShape: { type: "adaptive" },
  },
  "umans-flash": {
    max_tokens: 32767,
    effort: "high",
    thinking: true,
    top_k: null,
    canDisableThinking: true,
    thinkingShape: { type: "adaptive" },
  },
  "umans-deepseek-v4-flash-0731": {
    max_tokens: 32767,
    effort: "high",
    thinking: true,
    top_k: null,
    canDisableThinking: true,
    thinkingShape: { type: "enabled" },
  },
  "umans-kimi-k3": {
    max_tokens: 131071,
    effort: "max",
    thinking: true,
    top_k: null,
    canDisableThinking: true,
    thinkingShape: { type: "adaptive" },
  },
  "umans-kimi*": {
    max_tokens: 32767,
    effort: "high",
    thinking: true,
    top_k: null,
    canDisableThinking: false,
    thinkingShape: { type: "adaptive" },
  },
  "umans-qwen*": {
    max_tokens: 32767,
    effort: "high",
    thinking: true,
    top_k: null,
    canDisableThinking: true,
    thinkingShape: { type: "adaptive" },
  },
  "*": {
    max_tokens: 32767,
    effort: "high",
    thinking: true,
    top_k: null,
    canDisableThinking: true,
    thinkingShape: { type: "adaptive" },
  },
};

/**
 * Resolve a `StampPolicy` for `modelName` from the parsed catalog.
 *
 * When the catalog contains an entry for `modelName`, returns that entry's
 * `stamps` field (populated at parse time via `matchStampOverlay`). When the
 * model is absent from the catalog — e.g. the upstream /v1/models/info
 * endpoint is unavailable — falls back to `matchStampOverlay(modelName)` so
 * prefix-based policy resolution still works without a catalog.
 */
export function resolveStampPolicy(
  modelName: string | undefined,
  catalog: Map<string, ParsedModelInfo>,
): StampPolicy {
  if (typeof modelName === "string") {
    const entry = catalog.get(modelName);
    if (entry) return entry.stamps;
    return matchStampOverlay(modelName);
  }
  return STAMP_OVERLAY["*"];
}

/**
 * Match a model name against the overlay patterns and return its policy.
 * First-match-wins; `"*"` is the fallback. Exported for
 * `parseModelInfoResponse()` and unit tests.
 */
export function matchStampOverlay(modelName: string): StampPolicy {
  for (const [pattern, policy] of Object.entries(STAMP_OVERLAY)) {
    if (pattern === "*") return policy;
    if (pattern.endsWith("*")) {
      if (modelName.startsWith(pattern.slice(0, -1))) return policy;
    } else if (modelName === pattern) {
      return policy;
    }
  }
  // Unreachable — STAMP_OVERLAY always has a "*" fallback.
  return STAMP_OVERLAY["*"];
}

/**
 * Resolve the first matching `PerModelRule` from a config-provided rule list.
 * First-match-wins glob matching (same semantics as `matchStampOverlay`).
 * Returns `null` when no rule matches or the rules array is empty.
 */
export function resolvePerModelRule(
  modelName: string | undefined,
  rules: PerModelRule[],
): PerModelRule | null {
  if (!Array.isArray(rules) || rules.length === 0) return null;
  if (typeof modelName !== "string") return null;
  for (const rule of rules) {
    if (rule.pattern === "*") return rule;
    if (rule.pattern.endsWith("*")) {
      if (modelName.startsWith(rule.pattern.slice(0, -1))) return rule;
    } else if (modelName === rule.pattern) {
      return rule;
    }
  }
  return null;
}
