// Strip oh-my-openagent's [Category+Skill Reminder] injection from Anthropic
// request bodies before forwarding upstream.
//
// oh-my-openagent v4.18.x adds a `category-skill-reminder` hook that splices a
// synthetic text block into messages[0].content on turn 2. The injected block
// starts with "\n[Category+Skill Reminder]" and invalidates the Anthropic
// prompt cache prefix, dropping cache hit rate to ~0% for 1-2 turns.
//
// This module exposes a single pure function `stripOmoReminder(body)` that
// returns a new body with the reminder block removed from messages[0].content,
// or the original body unchanged if no reminder is present. It does not mutate
// the input. It is idempotent: running it twice produces the same result as
// running it once. It preserves all other content blocks and any
// cache_control breakpoints.

import type { AnthropicBody, ContentBlock } from "../types.js";

/** Marker prefix the oh-my-openagent `category-skill-reminder` hook uses. */
const OMO_REMINDER_MARKER = "\n[Category+Skill Reminder]";

/**
 * Returns true if `block` is the oh-my-openagent reminder text block.
 * Detection is by `text` content (not type), so the marker survives any
 * future reordering of block fields.
 */
function isOmoReminderBlock(block: ContentBlock): boolean {
  if (typeof block.text !== "string") return false;
  return block.text.startsWith(OMO_REMINDER_MARKER);
}

/**
 * Strip oh-my-openagent's [Category+Skill Reminder] injection from
 * messages[0].content on an Anthropic request body.
 *
 * - Pure: returns a new body; does not mutate the input.
 * - Idempotent: applying twice == applying once.
 * - Preserves all other content blocks and cache_control breakpoints.
 * - No-op on non-Anthropic shapes, empty messages, string content,
 *   missing messages, or bodies without the reminder.
 *
 * Returns the original body reference when nothing changed so callers can
 * cheaply detect "no change" via reference equality.
 */
export function stripOmoReminder(body: AnthropicBody): AnthropicBody {
  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return body;

  const first = messages[0];
  const content = first?.content;
  if (!Array.isArray(content)) return body;

  let removed = false;
  const nextContent: ContentBlock[] = [];
  for (const block of content) {
    if (block !== null && typeof block === "object" && isOmoReminderBlock(block)) {
      removed = true;
      continue;
    }
    nextContent.push(block);
  }
  if (!removed) return body;

  const nextFirst = { ...first, content: nextContent };
  const nextMessages = messages.slice();
  nextMessages[0] = nextFirst;
  return { ...body, messages: nextMessages };
}
