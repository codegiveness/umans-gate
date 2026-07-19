// Tests for restampBreakpoints — pure function that restamps cache_control
// breakpoints to Layout B (system[0] + last user message) on Anthropic
// request bodies.
//
// Layout B replaces the harness's tip-riding breakpoints (last assistant
// tool_use + last user tool_result) with a stable system breakpoint and a
// rolling last-user breakpoint. See ADR 0002.

import { expect, test } from "bun:test";
import { restampBreakpoints } from "../src/restamp-breakpoints.js";
import type { AnthropicBody, ContentBlock } from "../src/types.js";

// Helpers ────────────────────────────────────────────────────────────────

const CC = { type: "ephemeral" };

function msgsArr(body: AnthropicBody): ContentBlock[] {
  return (body.messages ?? []).flatMap((m) => (Array.isArray(m.content) ? m.content : []));
}

// ─── Tip-riding → Layout B ─────────────────────────────────────────────

test("restampBreakpoints: tip-riding breakpoints (sys + last assistant + last user) collapse to Layout B (sys + last user)", () => {
  const body: AnthropicBody = {
    system: [{ type: "text", text: "system prompt", cache_control: { ...CC } }],
    messages: [
      { role: "user", content: [{ type: "text", text: "first user" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "assistant reply" },
          { type: "tool_use", id: "t1", name: "n", input: {}, cache_control: { ...CC } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "r", cache_control: { ...CC } },
        ],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body); // new object returned
  // system[0] keeps its breakpoint
  expect(out.system).toBeInstanceOf(Array);
  expect((out.system as ContentBlock[])[0].cache_control).toEqual({ type: "ephemeral" });
  // All message blocks EXCEPT the last user's last block had cache_control stripped
  for (const b of msgsArr(out).slice(0, -1)) {
    expect(b.cache_control).toBeUndefined();
  }
  // Last block of last user message gets a breakpoint
  const lastUser = out.messages![out.messages!.length - 1];
  const lastBlock = (lastUser.content as ContentBlock[])[0];
  expect(lastBlock.cache_control).toEqual({ type: "ephemeral" });
});

// ─── System handling ───────────────────────────────────────────────────

test("restampBreakpoints: no system field → only last-user breakpoint placed", () => {
  const body: AnthropicBody = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body);
  expect(out.system).toBeUndefined();
  const last = (out.messages![0].content as ContentBlock[])[0];
  expect(last.cache_control).toEqual({ type: "ephemeral" });
});

test("restampBreakpoints: string system → system left alone, last-user breakpoint placed", () => {
  const body: AnthropicBody = {
    system: "I am a string system prompt.",
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hi" }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body);
  expect(out.system).toBe("I am a string system prompt."); // unchanged
  const last = (out.messages![0].content as ContentBlock[])[0];
  expect(last.cache_control).toEqual({ type: "ephemeral" });
});

test("restampBreakpoints: multiple system blocks → only system[0] keeps breakpoint; others stripped", () => {
  const body: AnthropicBody = {
    system: [
      { type: "text", text: "first", cache_control: { ...CC } },
      { type: "text", text: "second", cache_control: { ...CC } },
      { type: "text", text: "third", cache_control: { ...CC } },
    ],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body);
  const sys = out.system as ContentBlock[];
  expect(sys[0].cache_control).toEqual({ type: "ephemeral" });
  expect(sys[1].cache_control).toBeUndefined();
  expect(sys[2].cache_control).toBeUndefined();
});

test("restampBreakpoints: system[0] without breakpoint → breakpoint added (if text-typed)", () => {
  const body: AnthropicBody = {
    system: [{ type: "text", text: "system prompt" }], // no cache_control
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body);
  expect((out.system as ContentBlock[])[0].cache_control).toEqual({ type: "ephemeral" });
});

test("restampBreakpoints: system[0] that is not text-typed → no breakpoint added", () => {
  const body: AnthropicBody = {
    system: [{ type: "image", source: { type: "base64" } }], // not text
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body);
  expect((out.system as ContentBlock[])[0].cache_control).toBeUndefined();
});

test("restampBreakpoints: non-text system[0] with existing breakpoint → preserved (not stripped)", () => {
  const body: AnthropicBody = {
    system: [{ type: "image", source: { type: "base64" }, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body);
  // existing breakpoint on non-text system[0] is preserved (not stripped)
  expect((out.system as ContentBlock[])[0].cache_control).toEqual({ type: "ephemeral" });
});

test("restampBreakpoints: system[0] with absent type field → treated as text, breakpoint added", () => {
  // Blocks without a type field are conventionally text. We add a breakpoint.
  const body: AnthropicBody = {
    system: [{ text: "system prompt" }], // no type, no cache_control
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body);
  expect((out.system as ContentBlock[])[0].cache_control).toEqual({ type: "ephemeral" });
});

// ─── Last user message handling ───────────────────────────────────────

test("restampBreakpoints: no user-role message → only system breakpoint placed", () => {
  const body: AnthropicBody = {
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant only" }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).toBe(body); // no-op — already in target state (system bp, no eligible user msg)
  // system breakpoint kept
  expect((out.system as ContentBlock[])[0].cache_control).toEqual({ type: "ephemeral" });
  // no user message → no message breakpoint
  for (const b of msgsArr(out)) {
    expect(b.cache_control).toBeUndefined();
  }
});

test("restampBreakpoints: last user message with string content → no breakpoint placed on it", () => {
  const body: AnthropicBody = {
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    messages: [
      {
        role: "user",
        content: "a plain string user message", // not an array
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).toBe(body); // no-op — string content can't receive a breakpoint, system already has one
  // system breakpoint kept
  expect((out.system as ContentBlock[])[0].cache_control).toEqual({ type: "ephemeral" });
  // last user message had string content → no breakpoint placed
  expect(out.messages![0].content).toBe("a plain string user message");
});

test("restampBreakpoints: last user message found is the LAST user-role message, not the first", () => {
  const body: AnthropicBody = {
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "first user" }],
      },
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      {
        role: "user",
        content: [{ type: "text", text: "second user" }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body);
  // First user message's block should NOT have a breakpoint
  const firstUserBlock = (out.messages![0].content as ContentBlock[])[0];
  expect(firstUserBlock.cache_control).toBeUndefined();
  // Second (last) user message's block SHOULD have a breakpoint
  const lastUserBlock = (out.messages![2].content as ContentBlock[])[0];
  expect(lastUserBlock.cache_control).toEqual({ type: "ephemeral" });
});

test("restampBreakpoints: breakpoint placed on LAST block of last user message when multiple blocks", () => {
  const body: AnthropicBody = {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "part 1" },
          { type: "text", text: "part 2" },
          { type: "text", text: "part 3" },
        ],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body);
  const blocks = out.messages![0].content as ContentBlock[];
  expect(blocks[0].cache_control).toBeUndefined();
  expect(blocks[1].cache_control).toBeUndefined();
  expect(blocks[2].cache_control).toEqual({ type: "ephemeral" });
});

// ─── No-op cases ──────────────────────────────────────────────────────

test("restampBreakpoints: empty messages array → no-op, returns original reference", () => {
  const body: AnthropicBody = {
    messages: [],
  };

  const out = restampBreakpoints(body);

  expect(out).toBe(body); // same reference
});

test("restampBreakpoints: non-object body → no-op, returns original reference", () => {
  const out = restampBreakpoints(null as unknown as AnthropicBody);
  expect(out).toBe(null);

  const out2 = restampBreakpoints("string" as unknown as AnthropicBody);
  expect(out2).toBe("string");
});

test("restampBreakpoints: messages not an array → no-op, returns original reference", () => {
  const body = { messages: "not an array" } as unknown as AnthropicBody;

  const out = restampBreakpoints(body);

  expect(out).toBe(body);
});

// ─── Idempotency ──────────────────────────────────────────────────────

test("restampBreakpoints: applying twice produces same result as applying once", () => {
  const body: AnthropicBody = {
    system: [{ type: "text", text: "sys", cache_control: { ...CC } }],
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "n", input: {}, cache_control: { ...CC } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", content: "r", cache_control: { ...CC } },
        ],
      },
    ],
  };

  const once = restampBreakpoints(body);
  const twice = restampBreakpoints(once);

  // Should NOT return original reference on first call (body changed)
  expect(once).not.toBe(body);
  // Should return original reference on second call (already Layout B)
  expect(twice).toBe(once);
});

// ─── Already-Layout-B (no change) ────────────────────────────────────

test("restampBreakpoints: body already in Layout B → returns original reference", () => {
  const body: AnthropicBody = {
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "assistant", content: [{ type: "text", text: "reply" }] },
      {
        role: "user",
        content: [{ type: "text", text: "user msg", cache_control: { type: "ephemeral" } }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).toBe(body); // same reference — no change
});

// ─── No ttl value written ─────────────────────────────────────────────

test("restampBreakpoints: never writes a ttl value (CacheTtlStep handles that)", () => {
  const body: AnthropicBody = {
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "user", cache_control: { type: "ephemeral", ttl: "1h" } }],
      },
    ],
  };

  const out = restampBreakpoints(body);

  // The system breakpoint was preserved with its existing ttl (we don't strip it)
  const sysCc = (out.system as ContentBlock[])[0].cache_control;
  // If the input had ttl, we keep it; if it didn't, we don't add one.
  // But we never WRITE a ttl ourselves.
  expect(sysCc?.type).toBe("ephemeral");
  // The last-user block already had a breakpoint (with ttl). We preserve it
  // as-is (idempotency). We never WRITE a ttl ourselves — but we don't strip
  // an existing one either.
  const lastUserBlock = (out.messages![0].content as ContentBlock[])[0];
  expect(lastUserBlock.cache_control?.type).toBe("ephemeral");
  // The existing ttl is preserved (we don't touch what's already correct).
  expect(lastUserBlock.cache_control?.ttl).toBe("1h");
});

test("restampBreakpoints: when ADDING a fresh breakpoint, no ttl is written", () => {
  const body: AnthropicBody = {
    system: [{ type: "text", text: "sys" }], // no breakpoint
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "user" }], // no breakpoint
      },
    ],
  };

  const out = restampBreakpoints(body);

  expect(out).not.toBe(body);
  // Fresh system breakpoint we add: type only, no ttl
  const sysCc = (out.system as ContentBlock[])[0].cache_control;
  expect(sysCc).toEqual({ type: "ephemeral" });
  expect(sysCc?.ttl).toBeUndefined();
  // Fresh last-user breakpoint we add: type only, no ttl
  const lastUserBlock = (out.messages![0].content as ContentBlock[])[0];
  expect(lastUserBlock.cache_control).toEqual({ type: "ephemeral" });
  expect(lastUserBlock.cache_control?.ttl).toBeUndefined();
});
