// Shared parser for the /v1/models/info upstream response.
//
// Both src/models.ts (rich ModelInfo) and src/vision/catalog.ts (subset
// ModelInfo) consume the same JSON shape — a top-level object whose keys
// are model ids and whose values carry capabilities/base_model metadata.
// This module does the type-guarded extraction once into a normalized
// ParsedModelInfo; each caller projects to its own interface.

import { matchStampOverlay, type StampPolicy } from "./stamp-catalog.js";

/** Tristate vision support as encoded by the upstream API. */
export type VisionSupport = boolean | "via-handoff";

/**
 * Faithfully typed fields extracted from a single /v1/models/info entry.
 * Every field is populated; callers pick the subset they need.
 */
export interface ParsedModelInfo {
  name: string;
  display_name: string;
  description: string;
  base_model: {
    name: string;
    provider: string | undefined;
    family: string | undefined;
    oss_base: string | undefined;
  };
  capabilities: {
    max_completion_tokens: number;
    recommended_max_tokens: number;
    context_window: number;
    supports_vision: VisionSupport;
    supports_tools: boolean;
    reasoning: {
      supported: boolean;
      can_disable: boolean;
      levels: string[];
      default_level: string | null;
    };
  };
  benchmarks: Record<string, unknown>;
  weights: {
    precision: string | undefined;
    hf_url: string | undefined;
  };
  stage: string | undefined;
  lifecycle:
    | { production_start_date: string | undefined; playground_start_date: string | undefined }
    | undefined;
  /**
   * Stamp tuning resolved from the local `STAMP_OVERLAY` (ADR-0006).
   * Populated by matching the model name against overlay patterns; not
   * derived from upstream fields. The stamp pipeline reads this instead
   * of calling `isGlmModel()` / `modelMatchesThinkingPattern()`.
   */
  stamps: StampPolicy;
}

/** Untyped shape of a single entry as received from upstream. */
interface RawModelInfo {
  name?: unknown;
  display_name?: unknown;
  description?: unknown;
  base_model?: {
    name?: unknown;
    provider?: unknown;
    family?: unknown;
    oss_base?: unknown;
  };
  capabilities?: {
    max_completion_tokens?: unknown;
    recommended_max_tokens?: unknown;
    context_window?: unknown;
    supports_vision?: unknown;
    supports_tools?: unknown;
    reasoning?: {
      supported?: unknown;
      can_disable?: unknown;
      levels?: unknown;
      default_level?: unknown;
    };
  };
  benchmarks?: Record<string, unknown>;
  weights?: {
    precision?: unknown;
    hf_url?: unknown;
  };
  stage?: unknown;
  lifecycle?: {
    production_start_date?: unknown;
    playground_start_date?: unknown;
  };
}

/**
 * Parse a raw /v1/models/info JSON body into a map keyed by model id.
 *
 * Entries whose value is not an object are skipped (matching prior behavior
 * in both src/models.ts and src/vision/catalog.ts). Every field is
 * type-guarded; missing or wrong-typed fields fall back to defaults
 * identical to the inline code this replaces.
 */
export function parseModelInfoResponse(body: unknown): Map<string, ParsedModelInfo> {
  const out = new Map<string, ParsedModelInfo>();
  if (typeof body !== "object" || body === null) return out;

  for (const [key, rawVal] of Object.entries(body as Record<string, unknown>)) {
    if (typeof rawVal !== "object" || rawVal === null) continue;
    const v = rawVal as RawModelInfo;
    const caps = v.capabilities ?? {};
    const bm = v.base_model ?? {};
    const w = v.weights ?? {};
    const sv = caps.supports_vision;
    const supportsVision: VisionSupport =
      sv === true ? true : sv === "via-handoff" ? "via-handoff" : false;
    const reasoning = caps.reasoning ?? {};
    const levels = Array.isArray(reasoning.levels)
      ? reasoning.levels.filter((l) => typeof l === "string")
      : [];
    const name = typeof v.name === "string" ? v.name : key;
    out.set(key, {
      name,
      display_name: typeof v.display_name === "string" ? v.display_name : "",
      description: typeof v.description === "string" ? v.description : "",
      base_model: {
        name: typeof bm.name === "string" ? bm.name : "",
        provider: typeof bm.provider === "string" ? bm.provider : undefined,
        family: typeof bm.family === "string" ? bm.family : undefined,
        oss_base: typeof bm.oss_base === "string" ? bm.oss_base : undefined,
      },
      capabilities: {
        max_completion_tokens:
          typeof caps.max_completion_tokens === "number" ? caps.max_completion_tokens : 0,
        recommended_max_tokens:
          typeof caps.recommended_max_tokens === "number" ? caps.recommended_max_tokens : 0,
        context_window: typeof caps.context_window === "number" ? caps.context_window : 0,
        supports_vision: supportsVision,
        supports_tools: caps.supports_tools === true,
        reasoning: {
          supported: reasoning.supported === true,
          can_disable: reasoning.can_disable === true,
          levels,
          default_level:
            typeof reasoning.default_level === "string" ? reasoning.default_level : null,
        },
      },
      benchmarks: typeof v.benchmarks === "object" && v.benchmarks !== null ? v.benchmarks : {},
      weights: {
        precision: typeof w.precision === "string" ? w.precision : undefined,
        hf_url: typeof w.hf_url === "string" ? w.hf_url : undefined,
      },
      stage: typeof v.stage === "string" ? v.stage : undefined,
      lifecycle: v.lifecycle
        ? {
            production_start_date:
              typeof v.lifecycle.production_start_date === "string"
                ? v.lifecycle.production_start_date
                : undefined,
            playground_start_date:
              typeof v.lifecycle.playground_start_date === "string"
                ? v.lifecycle.playground_start_date
                : undefined,
          }
        : undefined,
      stamps: {
        ...matchStampOverlay(name),
        canDisableThinking: reasoning.can_disable === true,
      },
    });
  }
  return out;
}
