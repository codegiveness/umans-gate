// Concurrency weight computation.

/** Source of model weights derived from upstream pricing. */
export interface WeightModelSource {
  getWeight(modelId: string): number;
}

/** Compute the concurrency weight for a request.
 *
 * Weight is derived from model pricing via the provided WeightModelSource.
 * Returns 1 if the model is unknown or no source is available.
 */
export function computeRequestWeight(
  modelName: string | undefined,
  models: WeightModelSource | null,
): number {
  if (typeof modelName !== "string" || modelName === "") return 1;
  if (models) return models.getWeight(modelName);
  return 1;
}
