import { STAMP_REASONING_EFFORT_GLM_VALUE, STAMP_REASONING_EFFORT_VALUE } from "./config.js";

/** Returns true if the model name belongs to the umans-glm family. */
export function isGlmModel(modelName: string | undefined): boolean {
  return typeof modelName === "string" && modelName.startsWith("umans-glm");
}

/**
 * Resolve the effort level for a model.
 *
 * GLM models get "max"; all others get "high". When `enabled` is false,
 * returns undefined (stamping disabled). This is the single source of truth
 * for all GLM effort-policy decisions across the stamp pipeline.
 */
export function resolveEffortForModel(modelName: string | undefined, enabled: true): "high" | "max";
export function resolveEffortForModel(modelName: string | undefined, enabled: false): undefined;
export function resolveEffortForModel(
  modelName: string | undefined,
  enabled: boolean,
): "high" | "max" | undefined;
export function resolveEffortForModel(
  modelName: string | undefined,
  enabled: boolean,
): "high" | "max" | undefined {
  if (!enabled) return undefined;
  return isGlmModel(modelName) ? STAMP_REASONING_EFFORT_GLM_VALUE : STAMP_REASONING_EFFORT_VALUE;
}
