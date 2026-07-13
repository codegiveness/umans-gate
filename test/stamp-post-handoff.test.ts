// Characterization test: verifies that after the vision handoff modifies
// the request body, the cache_control TTL is re-stamped on the new body.
// This protects the post-handoff TTL re-stamp block (proxy.ts lines ~251-260)
// during the stamp pipeline refactor.
//
// Run: bun test test/stamp-post-handoff.test.ts

import { afterAll, beforeAll, expect, test } from "bun:test";
import { type MockUpstreamHandle, startMockLlmUpstream } from "./helpers/mock-llm-upstream";
import { type ProxyHandle, startProxy } from "./helpers/proxy";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 1x1 red PNG (base64). */
const RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const WRAPPED_PREFIX =
  "[Image content — analyzed by vision module, shown as text because the active model cannot see images:";

// ─── Mock vision upstream ───────────────────────────────────────────────────

interface MockVisionHandle {
  port: number;
  getCallCount(): number;
  close(): Promise<void>;
}

function startMockVisionUpstream(description: string): MockVisionHandle {
  let callCount = 0;
  const server = Bun.serve({
    port: 0,
    async fetch() {
      callCount++;
      return Response.json({
        id: "chatcmpl-vision-mock",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-4o",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: description },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      });
    },
  });
  return {
    port: server.port ?? 0,
    getCallCount: () => callCount,
    close: () =>
      new Promise<void>((res) => {
        server.stop(true);
        setTimeout(res, 150);
      }),
  };
}

// ─── Types for assertions ────────────────────────────────────────────────────

interface ContentPart {
  type: string;
  text?: string;
  image?: { source: { type: string; media_type: string; data: string } };
  cache_control?: { type: string; ttl?: string };
}

interface ReceivedBody {
  model?: string;
  messages?: Array<{ role: string; content: string | ContentPart[] }>;
}

// ─── Test ───────────────────────────────────────────────────────────────────

let upstream: MockUpstreamHandle;
let vision: MockVisionHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  upstream = startMockLlmUpstream();
  vision = startMockVisionUpstream("A red pixel.");
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${upstream.port}`,
    STAMP_CLAUDE_CODE_ENABLED: "true",
    WARMER_ENABLED: "false",
    USAGE_REFRESH_MS: "999999",
    VISION_STRATEGY: "always",
    VISION_TARGET: `http://127.0.0.1:${vision.port}/v1/chat/completions`,
    VISION_MODEL: "gpt-4o",
    UMANS_API_KEY: "test-key",
  });
});

afterAll(async () => {
  await proxy.kill();
  await upstream.close();
  await vision.close();
});

test("post-handoff TTL re-stamp on modified body (Anthropic route)", async () => {
  await sleep(100);
  upstream.reset();

  const sentBody = {
    model: "claude-sonnet-4-5",
    max_tokens: 50,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "What is this?" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: RED_PNG_B64,
            },
          },
        ],
      },
    ],
  };

  const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sentBody),
  });
  expect(res.status).toBe(200);
  await res.text();
  await sleep(200);

  // Vision was called once.
  expect(vision.getCallCount()).toBe(1);

  // Upstream received the modified body.
  expect(upstream.getCallCount()).toBe(1);
  const received = upstream.getRequest(0) as ReceivedBody;
  const parts = received.messages?.[0]?.content as ContentPart[];

  // The image block was replaced with a text block containing the wrapped
  // description.
  const descBlock = parts.find((p) => p.type === "text" && p.text?.includes(WRAPPED_PREFIX));
  expect(descBlock).toBeDefined();
  expect(descBlock?.text).toContain("A red pixel.");

  // The post-handoff TTL re-stamp applied cache_control ephemeral with ttl
  // to the new description text block.
  expect(descBlock?.cache_control).toBeDefined();
  expect(descBlock?.cache_control?.type).toBe("ephemeral");
  expect(descBlock?.cache_control?.ttl).toBe("1h");

  // No image blocks remain.
  expect(parts.some((p) => p.type === "image")).toBe(false);
});
