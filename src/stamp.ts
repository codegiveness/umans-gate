// Anthropic cache_control TTL stamping.
// Walks the request body's system + messages content arrays, stamping
// `ttl` onto any `cache_control: {type:"ephemeral"}` block that lacks one.

import type { AnthropicBody, ContentBlock } from "./types.js";

/**
 * Stamp `ttl` onto Anthropic-style cache_control ephemeral blocks that lack one.
 * Mutates the body in place. Returns the count of blocks stamped (caller
 * re-serializes only when > 0). Non-array system (e.g. a plain string) is
 * skipped safely.
 */
export function stampCacheTtl(body: AnthropicBody, ttl: string): number {
  let n = 0;

  const stamp = (blocks: unknown) => {
    if (!Array.isArray(blocks)) return;
    for (const b of blocks as ContentBlock[]) {
      const cc = b?.cache_control;
      if (cc?.type === "ephemeral" && !cc.ttl) {
        cc.ttl = ttl;
        n++;
      }
    }
  };

  stamp(body?.system);
  for (const m of body?.messages ?? []) {
    stamp(m.content);
  }

  return n;
}
