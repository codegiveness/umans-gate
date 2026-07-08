// Inject `top_k` into LLM request bodies before forwarding upstream.
// Applies to both OpenAI-compatible and Anthropic routes.
// Places `top_k` immediately after `model` for consistent wire ordering.
// Preserves any existing `top_k` value already set by the caller.

import { isGlmModel } from "./model-policy.js";
import { extractModelName } from "./models/name.js";

/**
 * Body shape we mutate — has a `model` and optional `top_k` at top level.
 * The rest is opaque (OpenAI/Anthropic bodies differ in structure).
 */
interface RequestBody {
  model?: unknown;
  top_k?: unknown;
  [key: string]: unknown;
}

/**
 * Inject `top_k` into a parsed request body, placing it right after `model`.
 * If `top_k` already exists on the body, it is preserved (not overwritten).
 * Mutates the body in place. Returns true if the body was changed.
 *
 * Key ordering: JSON.stringify emits string keys in insertion order. To place
 * `top_k` immediately after `model`, we rebuild the object as a new record
 * with model first, then top_k, then the remaining keys — guaranteeing wire
 * ordering matches the UMANS API convention and the benchmark harness.
 */
export function stampTopK(body: unknown, topK: number): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return false;
  const model = extractModelName(body);
  if (model === undefined) return false;
  if (!isGlmModel(model)) return false; // defense in depth — guard also in TopKStep.applies()
  const b = body as RequestBody;
  if (b.top_k !== undefined) return false; // caller already set — respect it

  // Rebuild with desired key order: model, top_k, then the rest.
  const rebuilt: Record<string, unknown> = {};
  rebuilt.model = model;
  rebuilt.top_k = topK;
  for (const k of Object.keys(b)) {
    if (k !== "model" && k !== "top_k") rebuilt[k] = b[k];
  }
  // Mutate original in place: clear then copy back.
  for (const k of Object.keys(b)) Reflect.deleteProperty(b, k);
  Object.assign(b, rebuilt);
  return true;
}
