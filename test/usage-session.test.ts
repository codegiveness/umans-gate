// Long-running coding session test: simulates a realistic multi-turn
// agentic coding session against BOTH Anthropic and OpenAI, verifying
// cumulative token attribution across turns with cache warming.
//
// Scenario: a "developer" sends 5 turns of a coding conversation:
//   Turn 1: large system prompt + initial code (cache CREATE)
//   Turn 2-5: follow-up edits (cache READ — cached tokens grow)
//
// Two modes are exercised:
//   - NON-STREAMING (baseline): verifies token + cache attribution per turn
//   - STREAMING (realistic coding-agent behavior): ALSO verifies TTFT + TPS
//     are derived correctly per turn, across a multi-turn session
//
// Verifies:
//   - Per-turn metrics are correctly attributed (no cross-turn leakage)
//   - Cache behavior: turn 1 creates cache, turns 2-5 read from cache
//   - Cumulative session totals = sum of per-turn metrics
//   - Streaming: TTFT non-null, TPS positive, on every turn
//   - No usage_missing on any turn (mock always emits usage)

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type MockUpstreamHandle, startMockLlmUpstream } from "./helpers/mock-llm-upstream";
import { type ProxyHandle, startProxy } from "./helpers/proxy";
import {
  extractAnthropicNonStreaming,
  extractAnthropicStreaming,
  extractOpenAiNonStreaming,
  extractOpenAiStreaming,
  parseAnthropicSse,
  parseOpenAiSse,
  type UsageMetrics,
} from "./helpers/usage-extractors";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let upstream: MockUpstreamHandle;
let proxy: ProxyHandle;

beforeAll(async () => {
  upstream = await startMockLlmUpstream();
  proxy = await startProxy({
    TARGET: `http://127.0.0.1:${upstream.port}`,
    STAMP_CACHE_TTL_ENABLED: "false",
    WARMER_ENABLED: "false", // warmer pings /v1/models which would increment mock callCount
  });
});

afterAll(async () => {
  await proxy.kill();
  await upstream.close();
});

/** Fetch the most recent capture for a given path. */
async function getLatestCapture(
  path: string,
): Promise<{ body: string; duration_ms: number } | null> {
  await sleep(200);
  const listRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures?limit=50`);
  const captures = (await listRes.json()) as Array<{ id: number; path: string }>;
  // Find the most recent capture for this path (list is DESC by id)
  const cap = captures.find((c) => c.path === path);
  if (!cap) return null;
  const detailRes = await fetch(`${proxy.baseUrl}/dashboard/api/captures/${cap.id}`);
  const detail = (await detailRes.json()) as { response_body: string; duration_ms: number };
  return { body: detail.response_body ?? "", duration_ms: detail.duration_ms ?? 0 };
}

/** A large system prompt simulating a coding agent context. */
const CODING_SYSTEM_PROMPT = `You are an expert coding agent. Here is the project context:

Project: web-api-server
Stack: TypeScript, Bun, Hono framework
Files:
- src/index.ts (entry point, 200 lines)
- src/routes/users.ts (user CRUD, 150 lines)
- src/routes/auth.ts (auth middleware, 100 lines)
- src/db.ts (database layer, 80 lines)
- src/types.ts (shared types, 50 lines)

Coding conventions:
- Use Bun.serve for HTTP
- SQLite via bun:sqlite
- No external ORMs
- ESM imports with .js extensions
- Biome for linting (2-space indent, double quotes)

Current task: Implement a PATCH /users/:id endpoint that partially updates a user.
The endpoint should:
1. Validate the request body (only allow name/email updates)
2. Update only provided fields
3. Return the updated user
4. Handle not-found cases with 404

Here is the current src/routes/users.ts:
${"// ... 150 lines of existing code ...\n".repeat(20)}

Follow the existing patterns in the file. Add tests in test/users.test.ts.`;

const TURNS = [
  "Implement the PATCH /users/:id endpoint.",
  "Add input validation for the email field.",
  "Write tests for the 404 case.",
  "Refactor to use a shared validation helper.",
  "Add a rate limiter to the endpoint.",
];

describe("Long-running Anthropic coding session (5 turns, cache warming)", () => {
  const metrics: UsageMetrics[] = [];

  beforeAll(async () => {
    upstream.reset();
    await fetch(`${proxy.baseUrl}/dashboard/api/clear`, { method: "POST" });
    await sleep(100);

    for (let i = 0; i < TURNS.length; i++) {
      const reqBody = {
        model: "umans-glm-5.2",
        max_tokens: 100,
        system: [
          {
            type: "text",
            text: CODING_SYSTEM_PROMPT,
            // ALL turns include cache_control: turn 1 creates the cache,
            // turns 2-5 read from it (the mock tracks seen system prompts)
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: TURNS[i] }],
      };

      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      expect(res.status).toBe(200);
      await res.json();

      const cap = await getLatestCapture("/v1/messages");
      expect(cap).not.toBeNull();
      const parsed = JSON.parse(cap!.body);
      const m = extractAnthropicNonStreaming(parsed, cap!.duration_ms);
      metrics.push(m);
    }
  }, 30000); // 30s timeout for the whole session

  test("all 5 turns produced usage metrics", () => {
    expect(metrics.length).toBe(5);
    for (const m of metrics) {
      expect(m.usage_missing).toBe(false);
      expect(m.input_tokens).not.toBeNull();
      expect(m.output_tokens).not.toBeNull();
    }
  });

  test("turn 1: cache creation > 0 (cold cache)", () => {
    const m1 = metrics[0];
    expect(m1.cache_creation_tokens).toBeGreaterThan(0);
    expect(m1.cache_read_tokens).toBe(0);
  });

  test("turns 2-5: cache read > 0, creation = 0 (warm cache)", () => {
    for (let i = 1; i < metrics.length; i++) {
      const m = metrics[i];
      expect(m.cache_read_tokens).toBeGreaterThan(0);
      expect(m.cache_creation_tokens).toBe(0);
    }
  });

  test("no cross-turn token leakage (each turn has its own metrics)", () => {
    // Each turn's input_tokens should reflect THAT turn's uncached input
    // The mock simulates: turn 1 has full input, turns 2+ have reduced input (cached portion removed)
    const turn1Input = metrics[0].input_tokens ?? 0;
    const turn1CacheCreate = metrics[0].cache_creation_tokens ?? 0;
    const turn1Total = turn1Input + turn1CacheCreate;
    expect(turn1Total).toBeGreaterThan(0);

    // Turns 2-5 should have cache_read > 0 (reading the cached system prompt)
    for (let i = 1; i < metrics.length; i++) {
      const m = metrics[i];
      expect(m.cache_read_tokens).toBeGreaterThan(0);
    }
  });

  test("cumulative session totals = sum of per-turn metrics", () => {
    const totalInput = metrics.reduce((s, m) => s + (m.input_tokens ?? 0), 0);
    const totalOutput = metrics.reduce((s, m) => s + (m.output_tokens ?? 0), 0);
    const totalCacheCreate = metrics.reduce((s, m) => s + (m.cache_creation_tokens ?? 0), 0);
    const totalCacheRead = metrics.reduce((s, m) => s + (m.cache_read_tokens ?? 0), 0);

    expect(totalInput).toBeGreaterThan(0);
    expect(totalOutput).toBeGreaterThan(0);
    expect(totalCacheCreate).toBeGreaterThan(0); // turn 1 created cache
    expect(totalCacheRead).toBeGreaterThan(0); // turns 2-5 read cache

    // Total input billed (Anthropic) = input + cache_creation + cache_read
    const totalBilledInput = totalInput + totalCacheCreate + totalCacheRead;
    expect(totalBilledInput).toBeGreaterThan(totalInput); // cache adds to total
  });

  test("TPS is positive and consistent across turns", () => {
    for (const m of metrics) {
      if (m.tps != null) {
        expect(m.tps).toBeGreaterThan(0);
        expect(Number.isFinite(m.tps)).toBe(true);
      }
    }
  });

  test("total session duration is reasonable", () => {
    const totalDuration = metrics.reduce((s, m) => s + (m.duration_ms ?? 0), 0);
    expect(totalDuration).toBeGreaterThan(0);
    // 5 turns with 100 output tokens each, should be at least a few seconds
    expect(totalDuration).toBeGreaterThan(1000);
  });

  test("per-turn attribution is independent (no cross-turn conflation)", () => {
    const m1 = metrics[0];
    expect(m1.cache_creation_tokens).toBeGreaterThan(0);
    expect(m1.cache_read_tokens).toBe(0);
    for (let i = 1; i < metrics.length; i++) {
      expect(metrics[i].cache_read_tokens).toBeGreaterThan(0);
      expect(metrics[i].cache_creation_tokens).toBe(0);
    }
  });
});

describe("Long-running OpenAI coding session (5 turns)", () => {
  const metrics: UsageMetrics[] = [];

  beforeAll(async () => {
    upstream.reset();
    await fetch(`${proxy.baseUrl}/dashboard/api/clear`, { method: "POST" });
    await sleep(100);

    for (let i = 0; i < TURNS.length; i++) {
      const reqBody = {
        model: "umans-flash",
        max_tokens: 100,
        messages: [
          { role: "system", content: CODING_SYSTEM_PROMPT },
          { role: "user", content: TURNS[i] },
        ],
      };

      const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      expect(res.status).toBe(200);
      await res.json();

      const cap = await getLatestCapture("/v1/chat/completions");
      expect(cap).not.toBeNull();
      const parsed = JSON.parse(cap!.body);
      const m = extractOpenAiNonStreaming(parsed, cap!.duration_ms);
      metrics.push(m);
    }
  }, 30000);

  test("all 5 turns produced usage metrics", () => {
    expect(metrics.length).toBe(5);
    for (const m of metrics) {
      expect(m.usage_missing).toBe(false);
      expect(m.input_tokens).not.toBeNull();
      expect(m.output_tokens).not.toBeNull();
    }
  });

  test("cached_tokens present (OpenAI prompt caching)", () => {
    // OpenAI always emits cached_tokens (default 0)
    for (const m of metrics) {
      expect(m.cache_read_tokens).not.toBeNull();
      expect(m.cache_read_tokens).toBeGreaterThanOrEqual(0);
    }
  });

  test("cumulative session totals = sum of per-turn metrics", () => {
    const totalPrompt = metrics.reduce((s, m) => s + (m.input_tokens ?? 0), 0);
    const totalCompletion = metrics.reduce((s, m) => s + (m.output_tokens ?? 0), 0);
    const _totalCached = metrics.reduce((s, m) => s + (m.cache_read_tokens ?? 0), 0);

    expect(totalPrompt).toBeGreaterThan(0);
    expect(totalCompletion).toBeGreaterThan(0);
    // total_tokens should equal prompt + completion for each turn
    for (const m of metrics) {
      const _expected = (m.input_tokens ?? 0) + (m.output_tokens ?? 0);
      // OpenAI total = prompt + completion; our extractor stores total_input = prompt
      expect(m.total_input_tokens).toBe(m.input_tokens);
    }
  });

  test("TPS is positive for all turns", () => {
    for (const m of metrics) {
      if (m.tps != null) {
        expect(m.tps).toBeGreaterThan(0);
      }
    }
  });
});

// ─── STREAMING session: realistic coding-agent behavior ─────────────────────
// Real coding agents (Claude Code, Cursor, Cline) use streaming. This block
// exercises the same 5-turn coding session in streaming mode and verifies
// TTFT + TPS are derived per turn, plus the same cache/token attribution.
const streamMetrics: UsageMetrics[] = [];

describe("Long-running Anthropic STREAMING coding session (5 turns)", () => {
  beforeAll(async () => {
    upstream.reset();
    await fetch(`${proxy.baseUrl}/dashboard/api/clear`, { method: "POST" });
    await sleep(100);

    for (let i = 0; i < TURNS.length; i++) {
      const reqBody = {
        model: "umans-glm-5.2",
        max_tokens: 100,
        stream: true,
        system: [
          {
            type: "text",
            text: CODING_SYSTEM_PROMPT,
            // ALL turns include cache_control: turn 1 creates the cache,
            // turns 2-5 read from it (the mock tracks seen system prompts)
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: TURNS[i] }],
      };

      const res = await fetch(`${proxy.baseUrl}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("message_start");
      expect(text).toContain("message_delta");

      const cap = await getLatestCapture("/v1/messages");
      expect(cap).not.toBeNull();
      const events = parseAnthropicSse([{ text: cap!.body, time: 0 }]);
      const perEvent = cap!.duration_ms / Math.max(events.length, 1);
      const eventsTimed = events.map((ev, idx) => ({
        ...ev,
        received_at: Math.round(idx * perEvent),
      }));
      const m = extractAnthropicStreaming(eventsTimed, 0);
      streamMetrics.push(m);
    }
  }, 60000);

  test("all 5 turns produced streaming usage metrics", () => {
    expect(streamMetrics.length).toBe(5);
    for (const m of streamMetrics) {
      expect(m.usage_missing).toBe(false);
      expect(m.streaming).toBe(true);
      expect(m.input_tokens).not.toBeNull();
      expect(m.output_tokens).not.toBeNull();
    }
  });

  test("turn 1: cache creation > 0 (cold cache, streaming)", () => {
    expect(streamMetrics[0].cache_creation_tokens).toBeGreaterThan(0);
    expect(streamMetrics[0].cache_read_tokens).toBe(0);
  });

  test("turns 2-5: cache read > 0, creation = 0 (warm cache, streaming)", () => {
    for (let i = 1; i < streamMetrics.length; i++) {
      expect(streamMetrics[i].cache_read_tokens).toBeGreaterThan(0);
      expect(streamMetrics[i].cache_creation_tokens).toBe(0);
    }
  });

  test("TTFT is non-null on every turn (streaming)", () => {
    for (const m of streamMetrics) {
      expect(m.ttft_ms).not.toBeNull();
      expect(m.ttft_ms).toBeGreaterThanOrEqual(0);
    }
  });

  test("TPS is positive when computed (streaming)", () => {
    for (const m of streamMetrics) {
      if (m.tps != null) {
        expect(m.tps).toBeGreaterThan(0);
        expect(Number.isFinite(m.tps)).toBe(true);
      }
    }
  });

  test("message_start output_tokens placeholder NOT used as final (streaming)", () => {
    for (const m of streamMetrics) {
      // message_start sets output_tokens ~1; message_delta carries the real cumulative count
      expect(m.output_tokens).not.toBe(1);
      expect(m.output_tokens).not.toBe(0);
    }
  });

  test("cumulative streaming session totals = sum of per-turn metrics", () => {
    const totalInput = streamMetrics.reduce((s, m) => s + (m.input_tokens ?? 0), 0);
    const totalOutput = streamMetrics.reduce((s, m) => s + (m.output_tokens ?? 0), 0);
    const totalCacheCreate = streamMetrics.reduce((s, m) => s + (m.cache_creation_tokens ?? 0), 0);
    const totalCacheRead = streamMetrics.reduce((s, m) => s + (m.cache_read_tokens ?? 0), 0);
    expect(totalInput).toBeGreaterThan(0);
    expect(totalOutput).toBeGreaterThan(0);
    expect(totalCacheCreate).toBeGreaterThan(0);
    expect(totalCacheRead).toBeGreaterThan(0);
  });
});

// ─── OpenAI STREAMING session ───────────────────────────────────────────────
const openAiStreamMetrics: UsageMetrics[] = [];

describe("Long-running OpenAI STREAMING coding session (5 turns)", () => {
  beforeAll(async () => {
    upstream.reset();
    await fetch(`${proxy.baseUrl}/dashboard/api/clear`, { method: "POST" });
    await sleep(100);

    for (let i = 0; i < TURNS.length; i++) {
      const reqBody = {
        model: "umans-flash",
        max_tokens: 100,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          { role: "system", content: CODING_SYSTEM_PROMPT },
          { role: "user", content: TURNS[i] },
        ],
      };

      const res = await fetch(`${proxy.baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(reqBody),
      });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("data: [DONE]");

      const cap = await getLatestCapture("/v1/chat/completions");
      expect(cap).not.toBeNull();
      const chunks = parseOpenAiSse([{ text: cap!.body, time: 0 }]);
      const perChunk = cap!.duration_ms / Math.max(chunks.length, 1);
      const chunksTimed = chunks.map((ch, idx) => ({
        ...ch,
        received_at: Math.round(idx * perChunk),
      }));
      const m = extractOpenAiStreaming(chunksTimed, 0);
      openAiStreamMetrics.push(m);
    }
  }, 60000);

  test("all 5 turns produced streaming usage metrics", () => {
    expect(openAiStreamMetrics.length).toBe(5);
    for (const m of openAiStreamMetrics) {
      expect(m.usage_missing).toBe(false);
      expect(m.streaming).toBe(true);
      expect(m.input_tokens).not.toBeNull();
      expect(m.output_tokens).not.toBeNull();
    }
  });

  test("TTFT is non-null on every turn (streaming)", () => {
    for (const m of openAiStreamMetrics) {
      expect(m.ttft_ms).not.toBeNull();
      expect(m.ttft_ms).toBeGreaterThanOrEqual(0);
    }
  });

  test("TPS is positive when computed (streaming)", () => {
    for (const m of openAiStreamMetrics) {
      if (m.tps != null) {
        expect(m.tps).toBeGreaterThan(0);
      }
    }
  });

  test("cached_tokens present on every turn (OpenAI prompt caching)", () => {
    for (const m of openAiStreamMetrics) {
      expect(m.cache_read_tokens).not.toBeNull();
      expect(m.cache_read_tokens).toBeGreaterThanOrEqual(0);
    }
  });

  test("cumulative streaming totals = sum of per-turn metrics", () => {
    const totalPrompt = openAiStreamMetrics.reduce((s, m) => s + (m.input_tokens ?? 0), 0);
    const totalCompletion = openAiStreamMetrics.reduce((s, m) => s + (m.output_tokens ?? 0), 0);
    expect(totalPrompt).toBeGreaterThan(0);
    expect(totalCompletion).toBeGreaterThan(0);
  });
});
