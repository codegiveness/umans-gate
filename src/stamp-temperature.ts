// Force `temperature` onto LLM request bodies before forwarding upstream.
// Applies to both OpenAI-compatible and Anthropic routes.
// Overwrites any existing `temperature` value already set by the caller.

interface RequestBody {
  temperature?: unknown;
  [key: string]: unknown;
}

/**
 * Force `temperature` onto a parsed request body, overwriting any existing value.
 * Mutates the body in place. Returns true if the body was changed.
 */
export function stampTemperature(body: unknown, temperature: number): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const b = body as RequestBody;
  if (b.temperature === temperature) return false;
  b.temperature = temperature;
  return true;
}
