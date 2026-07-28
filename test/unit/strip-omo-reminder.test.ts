// Tests for stripOmoReminder — pure function that removes oh-my-openagent's
// [Category+Skill Reminder] synthetic text block from messages[0].content.

import { expect, test } from "bun:test";
import { stripOmoReminder } from "../../src/experiments/strip-omo-reminder.js";
import type { AnthropicBody } from "../../src/types.js";

const REMINDER_TEXT =
  "\n[Category+Skill Reminder]\nCategories: coding. Skills: typescript, testing. Apply with care.";

test("stripOmoReminder: reminder block at messages[0].content[0] is removed; content[1] preserved", () => {
  const body: AnthropicBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: REMINDER_TEXT },
          { type: "text", text: "What is the capital of France?" },
        ],
      },
    ],
  };

  const cleaned = stripOmoReminder(body);

  expect(cleaned).not.toBe(body); // new object returned
  expect(cleaned.messages).not.toBe(body.messages); // messages array rebuilt
  expect(cleaned.messages[0].content).not.toBe(body.messages[0].content);
  expect(cleaned.messages![0].content).toHaveLength(1);
  expect((cleaned.messages![0].content as Array<{ text: string }>)[0].text).toBe(
    "What is the capital of France?",
  );
});

test("stripOmoReminder: body without reminder is returned unchanged (same reference)", () => {
  const body: AnthropicBody = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "Hello, world!" }],
      },
    ],
  };

  const cleaned = stripOmoReminder(body);
  expect(cleaned).toBe(body); // same reference — no copy made
});

test("stripOmoReminder: reminder at a non-zero index is removed correctly", () => {
  const body: AnthropicBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "First block, keep me." },
          { type: "text", text: REMINDER_TEXT },
          { type: "text", text: "Third block, also keep." },
        ],
      },
    ],
  };

  const cleaned = stripOmoReminder(body);
  const content = cleaned.messages![0].content as Array<{ text: string }>;
  expect(content).toHaveLength(2);
  expect(content[0].text).toBe("First block, keep me.");
  expect(content[1].text).toBe("Third block, also keep.");
});

test("stripOmoReminder: empty messages array is a no-op (same reference)", () => {
  const body: AnthropicBody = { messages: [] };
  const cleaned = stripOmoReminder(body);
  expect(cleaned).toBe(body);
});

test("stripOmoReminder: missing messages is a no-op (same reference)", () => {
  const body: AnthropicBody = { system: "You are helpful." };
  const cleaned = stripOmoReminder(body);
  expect(cleaned).toBe(body);
});

test("stripOmoReminder: string content on messages[0] is a no-op (same reference)", () => {
  const body: AnthropicBody = {
    messages: [{ role: "user", content: "plain string content" }],
  };
  const cleaned = stripOmoReminder(body);
  expect(cleaned).toBe(body);
});

test("stripOmoReminder: idempotent — applying twice equals applying once", () => {
  const body: AnthropicBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: REMINDER_TEXT },
          { type: "text", text: "Real prompt." },
        ],
      },
    ],
  };

  const once = stripOmoReminder(body);
  const twice = stripOmoReminder(once);

  expect(twice).toBe(once); // second pass finds nothing, returns same ref
  expect((twice.messages![0].content as unknown[]).length).toBe(1);
});

test("stripOmoReminder: preserves cache_control breakpoints on remaining blocks", () => {
  const body: AnthropicBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: REMINDER_TEXT },
          {
            type: "text",
            text: "Cached prompt.",
            cache_control: { type: "ephemeral", ttl: "1h" },
          },
        ],
      },
    ],
  };

  const cleaned = stripOmoReminder(body);
  const remaining = (
    cleaned.messages![0].content as Array<{
      text: string;
      cache_control?: { type: string; ttl?: string };
    }>
  )[0];
  expect(remaining.cache_control).toEqual({ type: "ephemeral", ttl: "1h" });
});

test("stripOmoReminder: multiple reminder blocks in messages[0] are all removed", () => {
  const body: AnthropicBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: REMINDER_TEXT },
          { type: "text", text: "keep" },
          { type: "text", text: REMINDER_TEXT },
        ],
      },
    ],
  };

  const cleaned = stripOmoReminder(body);
  expect((cleaned.messages![0].content as unknown[]).length).toBe(1);
});

test("stripOmoReminder: only the first message is scanned (reminder in messages[1] is kept)", () => {
  // Per spec: "scan messages[0].content[]" — only the first message is touched.
  const body: AnthropicBody = {
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
      {
        role: "user",
        content: [{ type: "text", text: REMINDER_TEXT }],
      },
    ],
  };

  const cleaned = stripOmoReminder(body);
  expect(cleaned).toBe(body); // no change — reminder not in messages[0]
});
