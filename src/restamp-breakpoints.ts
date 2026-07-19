// Restamp cache_control breakpoints to Layout B on Anthropic request bodies.
//
// The harness (opencode) places breakpoints on the rolling message tip —
// the last assistant tool_use and the last user tool_result. Each turn, as
// new messages arrive, the harness strips the breakpoint from the
// previously-tip blocks and re-adds it to the new tip. Because Anthropic
// hashes the cumulative prefix through each breakpoint, this repositioning
// invalidates the prefix hash and forces a partial cache re-read every
// turn. See ADR 0002 and the `Breakpoint repositioning` glossary entry.
//
// Layout B replaces the tip-riding breakpoints with:
//   - system[0]'s breakpoint (stable system prefix)
//   - a breakpoint on the last block of the last user message (rolling tip)
//
// This module exposes a single pure function `restampBreakpoints(body)`.
// It returns a new body with breakpoints restamped to Layout B, or the
// original body reference unchanged if no change was needed. It does not
// mutate the input. It is idempotent. It never writes a `ttl` value —
// `CacheTtlStep` handles that in the pipeline.

import type { AnthropicBody, ContentBlock } from "./types.js";

/** A breakpoint annotation we place/keep. Never carries a `ttl` here. */
const BREAKPOINT = { type: "ephemeral" } as const;

/** True if a block is text-typed (explicit `text` or absent `type`). */
function isTextBlock(block: ContentBlock): boolean {
  return block.type === "text" || block.type === undefined;
}

/** True if a block carries an ephemeral cache_control breakpoint. */
function hasBreakpoint(block: ContentBlock | undefined | null): boolean {
  return block?.cache_control?.type === "ephemeral";
}

/** Strip `cache_control` from a block, returning a new block without it. */
function stripBreakpoint(block: ContentBlock): ContentBlock {
  if (!hasBreakpoint(block)) return block;
  const { cache_control: _drop, ...rest } = block;
  return rest as ContentBlock;
}

/** Add an ephemeral breakpoint to a block that lacks one. No-op if already present. */
function withBreakpoint(block: ContentBlock): ContentBlock {
  if (hasBreakpoint(block)) return block;
  return { ...block, cache_control: { ...BREAKPOINT } };
}

/**
 * Restamp `cache_control` breakpoints to Layout B on an Anthropic request body.
 *
 * - Pure: returns a new body; does not mutate the input.
 * - Idempotent: applying twice == applying once.
 * - Never writes a `ttl` value (CacheTtlStep handles that).
 * - Never converts a string `system` or string `content` to an array.
 * - No-op on non-Anthropic shapes, empty messages, string content,
 *   missing messages, or bodies already in Layout B.
 *
 * Returns the original body reference when nothing changed so callers can
 * cheaply detect "no change" via reference equality.
 */
export function restampBreakpoints(body: AnthropicBody): AnthropicBody {
  if (body === null || typeof body !== "object") return body;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return body;

  // Locate the last user message with array content (target for breakpoint).
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === "user" && Array.isArray(m?.content) && m.content.length > 0) {
      lastUserIdx = i;
      break;
    }
  }

  let changed = false;

  // ─── 1. Rebuild messages: strip all breakpoints, then add one to last user's last block ─
  const newMessages = messages.map((m, mi) => {
    const content = m?.content;
    if (!Array.isArray(content)) return m;

    let blockChanged = false;
    const newContent = content.map((b, bi) => {
      const isLastBlockOfLastUser = mi === lastUserIdx && bi === content.length - 1;
      const shouldHaveBp = isLastBlockOfLastUser;
      const hasBp = hasBreakpoint(b);

      if (shouldHaveBp && !hasBp) {
        blockChanged = true;
        return withBreakpoint(b);
      }
      if (!shouldHaveBp && hasBp) {
        blockChanged = true;
        return stripBreakpoint(b);
      }
      return b;
    });

    if (!blockChanged) return m;
    changed = true;
    return { ...m, content: newContent };
  });

  // ─── 2. Rebuild system: keep only system[0]'s breakpoint ─────────────
  let newSystem = body.system;
  if (Array.isArray(body.system)) {
    let sysChanged = false;
    const rebuilt = body.system.map((b, i) => {
      if (i === 0) {
        if (isTextBlock(b)) {
          if (!hasBreakpoint(b)) {
            sysChanged = true;
            return withBreakpoint(b);
          }
          return b;
        }
        // non-text system[0]: preserve existing breakpoint (don't add, don't strip)
        return b;
      }
      // system[i>0]: strip any breakpoint
      if (hasBreakpoint(b)) {
        sysChanged = true;
        return stripBreakpoint(b);
      }
      return b;
    });
    if (sysChanged) {
      changed = true;
      newSystem = rebuilt;
    }
  }

  if (!changed) return body;

  return { ...body, system: newSystem, messages: newMessages };
}
