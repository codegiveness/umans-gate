/**
 * Check whether a model name contains a target version segment.
 * Used by the stamp pipeline to gate version-specific thinking shapes.
 *
 * Matching is substring-based on the version segment, not a full semver
 * comparison. This keeps the logic simple and robust to naming variations
 * (`umans-glm-5.2-turbo`, `umans-kimi-k2.7-code-highspeed`).
 *
 * @param modelName - The full model name from the request body (e.g. "umans-glm-5.2")
 * @param targetVersion - The version segment to match (e.g. "5.2", "k2.7-code")
 * @returns true if the model name contains the target version segment
 */
export function modelVersionMatches(modelName: string | undefined, targetVersion: string): boolean {
  if (!modelName || !targetVersion) return false;
  return modelName.includes(targetVersion);
}
