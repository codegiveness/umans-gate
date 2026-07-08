/**
 * Extract a model name from a parsed request body.
 * Returns the string value of `body.model` when the body is a non-null object
 * and `model` is a string; otherwise returns `undefined`.
 */
export function extractModelName(body: unknown): string | undefined {
  if (body === null || typeof body !== "object") return undefined;
  const model = (body as { model?: unknown }).model;
  if (typeof model !== "string") return undefined;
  return model;
}
