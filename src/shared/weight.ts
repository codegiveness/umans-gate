// Concurrency weight computation.

/** Source of last-resort model weights when a model is not in config weights. */
export interface WeightModelSource {
  getWeight(modelId: string): number;
}

/** Compute the concurrency weight for a request.
 *
 * Precedence:
 * 1. `config.concurrencyWeights` override if present (including explicit 0).
 * 2. `models.getWeight(modelId)` if a model source is provided.
 * 3. Default weight of 1.
 */
export function computeRequestWeight(
  config: { concurrencyWeights: Record<string, number> },
  modelName: string | undefined,
  models: WeightModelSource | null,
): number {
  if (typeof modelName !== "string" || modelName === "") return 1;
  if (modelName in config.concurrencyWeights) return config.concurrencyWeights[modelName];
  if (models) return models.getWeight(modelName);
  return 1;
}
