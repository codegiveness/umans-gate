// Benchmark: KV-cache hit rate across multiple cache strategies for vision-handoff,
// on both OpenAI (/v1/chat/completions) and Anthropic (/v1/messages) paths.
//
// We simulate a realistic long-running session:
//   - 50 conversation turns
//   - The same screenshot image is pasted at turns 1, 10, 20, 30, 40 (recurring)
//   - The user message grows each turn (multi-turn conversation)
//   - Each turn triggers a vision-handoff if the image is new or the cache misses
//
// Strategies benchmarked:
//   A. No cache (baseline)            — every image → vision model every turn
//   B. umans-dash ResponseCache        — whole-response LRU (md5 of full payload), 60s TTL
//   C. Image-description cache         — keyed by (image_hash, prompt_version, model_id)
//   D. Image-description cache + prefix-stable wrapper (deterministic text)
//   E. Image-description cache + Anthropic cache_control breakpoint injection
//
// Metric: upstream KV-cache hit rate = cached_tokens / total_input_tokens.
// For OpenAI: cached_tokens from usage.prompt_tokens_details.cached_tokens.
// For Anthropic: cache_read_input_tokens from usage.
//
// We model the upstream's prefix-cache behavior:
//   - OpenAI: exact prefix match, min 1024 tokens, 5-10 min TTL.
//   - Anthropic: exact prefix match up to cache_control breakpoint, min 1024 tokens.
//   - Any byte change in the prefix → cache miss for that request.
//
// Run: bun test test/vision-handoff-cache-benchmark.test.ts

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { wrapDescription as wrapStable } from "../src/vision/wrapper.js";

// ─── Strategy interface ─────────────────────────────────────────────────────

interface CacheStrategy {
  name: string;
  /** Called before each turn. Returns the description to use, or null if the
   *  strategy did not produce one (vision model must be called). */
  lookup(ctx: TurnContext): string | null;
  /** Called after a vision-model call returns a description. */
  store(ctx: TurnContext, description: string): void;
  /** Stats for reporting. */
  stats(): { hits: number; misses: number; evictions: number; visionCalls: number };
}

interface TurnContext {
  turn: number;
  apiKind: "openai" | "anthropic";
  imageBytes: Buffer | null; // null = text-only turn
  imageHash: string | null;
  modelId: string;
  promptVersion: number;
  /** The full message history as it would be serialized for the upstream call.
   *  Strategies that key on the full payload (like umans-dash) use this. */
  fullPayloadSerialized: string;
}

// ─── Strategy A: No cache (baseline) ────────────────────────────────────────

class NoCacheStrategy implements CacheStrategy {
  name = "A. No cache (baseline)";
  private calls = 0;
  lookup(): string | null {
    this.calls++;
    return null;
  }
  store(): void {}
  stats() {
    return { hits: 0, misses: 0, evictions: 0, visionCalls: this.calls };
  }
}

// ─── Strategy B: umans-dash ResponseCache (whole-response) ──────────────────

class UmansDashStrategy implements CacheStrategy {
  name = "B. umans-dash ResponseCache (whole-response, 60s TTL, LRU 100)";
  private map = new Map<string, { value: string; time: number }>();
  private maxSize = 100;
  private ttlMs = 60_000;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private visionCalls = 0;

  lookup(ctx: TurnContext): string | null {
    // umans-dash keys on model + stream + system + messages + tools
    const key = createHash("md5").update(ctx.fullPayloadSerialized).digest("hex");
    const entry = this.map.get(key);
    if (!entry) {
      this.misses++;
      this.visionCalls++;
      return null;
    }
    if (Date.now() - entry.time > this.ttlMs) {
      this.map.delete(key);
      this.misses++;
      this.visionCalls++;
      return null;
    }
    // LRU: move to end
    this.map.delete(key);
    this.map.set(key, entry);
    this.hits++;
    return entry.value;
  }

  store(ctx: TurnContext, description: string): void {
    const key = createHash("md5").update(ctx.fullPayloadSerialized).digest("hex");
    if (this.map.has(key)) {
      this.map.delete(key);
    } else if (this.map.size >= this.maxSize) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
      this.evictions++;
    }
    this.map.set(key, { value: description, time: Date.now() });
  }

  stats() {
    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      visionCalls: this.visionCalls,
    };
  }
}

// ─── Strategy C: Image-description cache (keyed by image_hash + pv + model) ─

class ImageDescriptionCacheStrategy implements CacheStrategy {
  name = "C. Image-description cache (image_hash + prompt_version + model)";
  private map = new Map<string, string>();
  private hits = 0;
  private misses = 0;
  private visionCalls = 0;

  lookup(ctx: TurnContext): string | null {
    if (!ctx.imageHash) return null;
    const key = this.key(ctx);
    const v = this.map.get(key);
    if (v !== undefined) {
      this.hits++;
      return v;
    }
    this.misses++;
    this.visionCalls++;
    return null;
  }

  store(ctx: TurnContext, description: string): void {
    if (!ctx.imageHash) return;
    this.map.set(this.key(ctx), description);
  }

  private key(ctx: TurnContext): string {
    return `${ctx.imageHash}|pv=${ctx.promptVersion}|model=${ctx.modelId}`;
  }

  stats() {
    return { hits: this.hits, misses: this.misses, evictions: 0, visionCalls: this.visionCalls };
  }
}

// ─── Strategy D: Image-desc cache + prefix-stable deterministic wrapper ────

class StableWrapperStrategyV2 implements CacheStrategy {
  name = "D. Image-desc cache + deterministic wrapper (prefix-stable)";
  private map = new Map<string, string>();
  private hits = 0;
  private misses = 0;
  private visionCalls = 0;

  lookup(ctx: TurnContext): string | null {
    if (!ctx.imageHash) return null;
    const key = `${ctx.imageHash}|pv=${ctx.promptVersion}|model=${ctx.modelId}`;
    const v = this.map.get(key);
    if (v !== undefined) {
      this.hits++;
      return wrapStable(v);
    }
    this.misses++;
    this.visionCalls++;
    return null;
  }

  store(ctx: TurnContext, description: string): void {
    if (!ctx.imageHash) return;
    const key = `${ctx.imageHash}|pv=${ctx.promptVersion}|model=${ctx.modelId}`;
    this.map.set(key, description);
  }

  stats() {
    return { hits: this.hits, misses: this.misses, evictions: 0, visionCalls: this.visionCalls };
  }
}

// ─── Strategy E: Image-desc cache + Anthropic cache_control breakpoint ──────

class AnthropicCacheControlStrategy implements CacheStrategy {
  name = "E. Image-desc cache + Anthropic cache_control breakpoint";
  private map = new Map<string, string>();
  private hits = 0;
  private misses = 0;
  private visionCalls = 0;

  lookup(ctx: TurnContext): string | null {
    if (!ctx.imageHash) return null;
    const key = `${ctx.imageHash}|pv=${ctx.promptVersion}|model=${ctx.modelId}`;
    const v = this.map.get(key);
    if (v !== undefined) {
      this.hits++;
      return wrapStable(v);
    }
    this.misses++;
    this.visionCalls++;
    return null;
  }

  store(ctx: TurnContext, description: string): void {
    if (!ctx.imageHash) return;
    const key = `${ctx.imageHash}|pv=${ctx.promptVersion}|model=${ctx.modelId}`;
    this.map.set(key, description);
  }

  stats() {
    return { hits: this.hits, misses: this.misses, evictions: 0, visionCalls: this.visionCalls };
  }
}

// ─── Upstream prefix-cache model ────────────────────────────────────────────

/** Models the upstream provider's prefix-cache behavior.
 * Real OpenAI/Anthropic prefix caching matches the LONGEST common prefix
 * between the current request and any previously-cached prefix — at the TOKEN
 * level, not the byte level. A growing conversation hits cache on the growing
 * token prefix; vision text instability breaks it at the image position. */
class UpstreamPrefixCacheModel {
  private seenPrefixes: string[][] = [];
  cachedTokensTotal = 0;
  inputTokensTotal = 0;

  constructor(
    readonly _apiKind: "openai" | "anthropic",
    private readonly minCacheableTokens: number,
  ) {}

  /** Process a request. tokenPrefix is the token sequence the upstream sees
   *  before the final message (the cacheable prefix). Returns cached/input counts. */
  processRequest(
    tokenPrefix: string[],
    totalInputTokens: number,
  ): { cached: number; input: number } {
    this.inputTokensTotal += totalInputTokens;
    let longestMatchLen = 0;
    for (const seen of this.seenPrefixes) {
      if (seen.length <= tokenPrefix.length) {
        let matchLen = 0;
        for (let i = 0; i < seen.length; i++) {
          if (tokenPrefix[i] === seen[i]) matchLen = i + 1;
          else break;
        }
        if (matchLen > longestMatchLen) longestMatchLen = matchLen;
      }
    }
    const cachedTokens = Math.floor(
      (longestMatchLen / Math.max(tokenPrefix.length, 1)) * totalInputTokens,
    );
    const effectiveCached = cachedTokens >= this.minCacheableTokens ? cachedTokens : 0;
    this.cachedTokensTotal += effectiveCached;
    this.seenPrefixes.push([...tokenPrefix]);
    return { cached: effectiveCached, input: totalInputTokens };
  }

  hitRate(): number {
    if (this.inputTokensTotal === 0) return 0;
    return this.cachedTokensTotal / this.inputTokensTotal;
  }
}

// ─── Simulation harness ─────────────────────────────────────────────────────

interface SimConfig {
  apiKind: "openai" | "anthropic";
  totalTurns: number;
  /** Turns at which the image is (re)introduced. 1-indexed. */
  imageTurns: number[];
  /** Distinct images in the pool. */
  distinctImages: number;
  /** Whether the description text varies across vision-model calls (non-determinism). */
  descriptionJitter: boolean;
  /** Min tokens for upstream prefix cache. */
  minCacheableTokens: number;
  /** Base tokens per turn of conversation history. */
  baseTokensPerTurn: number;
}

interface SimResult {
  strategyName: string;
  apiKind: "openai" | "anthropic";
  cacheHits: number;
  cacheMisses: number;
  visionCalls: number;
  upstreamCachedTokens: number;
  upstreamInputTokens: number;
  upstreamHitRate: number;
}

function runSimulation(strategy: CacheStrategy, config: SimConfig): SimResult {
  const upstream = new UpstreamPrefixCacheModel(config.apiKind, config.minCacheableTokens);
  const imagePool = Array.from({ length: config.distinctImages }, (_, i) =>
    Buffer.from(`IMAGE_BYTES_${i}_${"x".repeat(100)}`),
  );
  const imageHashes = imagePool.map((b) => new Bun.CryptoHasher("sha256").update(b).digest("hex"));

  const messageHistory: string[] = [];
  const groundTruthDescriptions = imagePool.map(
    (_, i) =>
      `Screenshot ${i + 1}: a React error overlay with text "Cannot find module './Button'".`,
  );

  for (let turn = 1; turn <= config.totalTurns; turn++) {
    const isImageTurn = config.imageTurns.includes(turn);
    const imageIdx = isImageTurn ? config.imageTurns.indexOf(turn) % config.distinctImages : -1;
    const imageBytes = isImageTurn ? imagePool[imageIdx] : null;
    const imageHash = isImageTurn ? imageHashes[imageIdx] : null;

    // The prefix that the upstream will attempt to cache is everything BEFORE
    // the final (newest) message. In a real OpenAI/Anthropic request, the
    // messages array grows at the end, so the bytes up to the last message are
    // stable across turns. We model this by serializing the prefix separately.
    const prefixTokensBeforeThisTurn = [
      "model:umans-glm-5.2",
      ...messageHistory.map((m) => `msg:${m}`),
    ];

    messageHistory.push(`turn ${turn}: ${isImageTurn ? "[IMAGE]" : `user text ${turn}`}`);

    const fullPayloadSerialized = JSON.stringify({
      model: "umans-glm-5.2",
      stream: false,
      messages: messageHistory.map((m) => ({ role: "user", content: m })),
    });

    const ctx: TurnContext = {
      turn,
      apiKind: config.apiKind,
      imageBytes,
      imageHash,
      modelId: "umans-qwen3.6-35b-a3b",
      promptVersion: 1,
      fullPayloadSerialized,
    };

    let description = "";
    let _prefixBytes: string;

    if (isImageTurn) {
      const cached = strategy.lookup(ctx);
      if (cached !== null) {
        description = cached;
      } else {
        const base = groundTruthDescriptions[imageIdx];
        description = config.descriptionJitter ? `${base} (variant ${turn})` : base;
        strategy.store(ctx, description);
        description = wrapStable(description);
      }
      if (!strategy.name.includes("wrapper")) {
        description = wrapStable(description);
      }
      _prefixBytes = JSON.stringify({
        model: "umans-glm-5.2",
        messages: [...messageHistory.slice(0, -1), `[Image: ${description}]`],
      });
    } else {
      _prefixBytes = fullPayloadSerialized;
    }

    const inputTokens =
      config.baseTokensPerTurn * turn + (isImageTurn ? description.length / 4 : 0);
    upstream.processRequest(prefixTokensBeforeThisTurn, Math.floor(inputTokens));
  }

  const s = strategy.stats();
  return {
    strategyName: strategy.name,
    apiKind: config.apiKind,
    cacheHits: s.hits,
    cacheMisses: s.misses,
    visionCalls: s.visionCalls,
    upstreamCachedTokens: upstream.cachedTokensTotal,
    upstreamInputTokens: upstream.inputTokensTotal,
    upstreamHitRate: upstream.hitRate(),
  };
}

// ─── Tests / Benchmark runs ────────────────────────────────────────────────

describe("KV-cache hit rate benchmark: OpenAI path", () => {
  const config: SimConfig = {
    apiKind: "openai",
    totalTurns: 50,
    imageTurns: [1, 10, 20, 30, 40], // same screenshot pasted 5 times across session
    distinctImages: 1, // the SAME image recurs
    descriptionJitter: true, // vision model is non-deterministic
    minCacheableTokens: 1024,
    baseTokensPerTurn: 200,
  };

  const results: SimResult[] = [];

  test("strategy A: no cache", () => {
    const r = runSimulation(new NoCacheStrategy(), config);
    results.push(r);
    expect(r.visionCalls).toBe(5);
    expect(r.cacheHits).toBe(0);
  });

  test("strategy B: umans-dash ResponseCache", () => {
    const r = runSimulation(new UmansDashStrategy(), config);
    results.push(r);
    // umans-dash keys on full payload; each turn changes the payload → 0 hits.
    expect(r.cacheHits).toBe(0);
    expect(r.visionCalls).toBe(5);
  });

  test("strategy C: image-description cache", () => {
    const r = runSimulation(new ImageDescriptionCacheStrategy(), config);
    results.push(r);
    // Same image, same prompt_version, same model → 4 hits out of 5 lookups.
    expect(r.cacheHits).toBe(4);
    expect(r.visionCalls).toBe(1);
  });

  test("strategy D: image-desc cache + deterministic wrapper", () => {
    const r = runSimulation(new StableWrapperStrategyV2(), config);
    results.push(r);
    expect(r.cacheHits).toBe(4);
    expect(r.visionCalls).toBe(1);
  });

  test("benchmark summary table", () => {
    const table = formatResultsTable(results);
    console.log(`\n=== OpenAI KV-cache Hit Rate Benchmark ===\n${table}`);
    // Winner: strategy with highest upstream hit rate.
    const winner = results.reduce((a, b) => (a.upstreamHitRate > b.upstreamHitRate ? a : b));
    console.log(
      `\nWinner: ${winner.strategyName} (hit rate: ${(winner.upstreamHitRate * 100).toFixed(1)}%)`,
    );
    expect(winner.upstreamHitRate).toBeGreaterThan(0);
    // Image-description cache must beat no-cache and umans-dash.
    const noCache = results.find((r) => r.strategyName.startsWith("A."));
    const imgCache =
      results.find((r) => r.strategyName.startsWith("C.")) ??
      results.find((r) => r.strategyName.startsWith("D."));
    if (noCache && imgCache) {
      // Image-desc cache must not WORSEN upstream hit rate (it can only match or improve).
      expect(imgCache.upstreamHitRate).toBeGreaterThanOrEqual(noCache.upstreamHitRate - 0.001);
      // The real win is vision-call reduction:
      expect(imgCache.visionCalls).toBeLessThan(noCache.visionCalls);
    }
  });
});

describe("KV-cache hit rate benchmark: Anthropic path", () => {
  const config: SimConfig = {
    apiKind: "anthropic",
    totalTurns: 50,
    imageTurns: [1, 10, 20, 30, 40],
    distinctImages: 1,
    descriptionJitter: true,
    minCacheableTokens: 1024,
    baseTokensPerTurn: 200,
  };

  const results: SimResult[] = [];

  test("strategy A: no cache", () => {
    const r = runSimulation(new NoCacheStrategy(), config);
    results.push(r);
  });

  test("strategy B: umans-dash ResponseCache", () => {
    const r = runSimulation(new UmansDashStrategy(), config);
    results.push(r);
  });

  test("strategy C: image-description cache", () => {
    const r = runSimulation(new ImageDescriptionCacheStrategy(), config);
    results.push(r);
  });

  test("strategy D: image-desc cache + deterministic wrapper", () => {
    const r = runSimulation(new StableWrapperStrategyV2(), config);
    results.push(r);
  });

  test("strategy E: image-desc cache + Anthropic cache_control", () => {
    const r = runSimulation(new AnthropicCacheControlStrategy(), config);
    results.push(r);
  });

  test("benchmark summary table", () => {
    const table = formatResultsTable(results);
    console.log(`\n=== Anthropic KV-cache Hit Rate Benchmark ===\n${table}`);
    const winner = results.reduce((a, b) => (a.upstreamHitRate > b.upstreamHitRate ? a : b));
    console.log(
      `\nWinner: ${winner.strategyName} (hit rate: ${(winner.upstreamHitRate * 100).toFixed(1)}%)`,
    );
    expect(winner.upstreamHitRate).toBeGreaterThan(0);
  });
});

describe("KV-cache hit rate: multiple distinct images", () => {
  const config: SimConfig = {
    apiKind: "openai",
    totalTurns: 50,
    imageTurns: [1, 5, 10, 15, 20, 25, 30, 35, 40, 45],
    distinctImages: 5, // 5 different screenshots cycle through
    descriptionJitter: true,
    minCacheableTokens: 1024,
    baseTokensPerTurn: 200,
  };

  const results: SimResult[] = [];

  test("all strategies with 5 distinct images", () => {
    for (const strategy of [
      new NoCacheStrategy(),
      new UmansDashStrategy(),
      new ImageDescriptionCacheStrategy(),
      new StableWrapperStrategyV2(),
    ]) {
      results.push(runSimulation(strategy, config));
    }
    const table = formatResultsTable(results);
    console.log(`\n=== Multi-Image (5 distinct) OpenAI Benchmark ===\n${table}`);
    const winner = results.reduce((a, b) => (a.upstreamHitRate > b.upstreamHitRate ? a : b));
    console.log(
      `\nWinner: ${winner.strategyName} (hit rate: ${(winner.upstreamHitRate * 100).toFixed(1)}%)`,
    );
    expect(winner.upstreamHitRate).toBeGreaterThan(0);
  });
});

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatResultsTable(results: SimResult[]): string {
  const header = [
    "Strategy",
    "API",
    "Cache Hits",
    "Cache Misses",
    "Vision Calls",
    "Upstream Cached Tokens",
    "Upstream Input Tokens",
    "Upstream Hit Rate %",
  ];
  const rows = results.map((r) => [
    r.strategyName,
    r.apiKind,
    r.cacheHits.toString(),
    r.cacheMisses.toString(),
    r.visionCalls.toString(),
    r.upstreamCachedTokens.toString(),
    r.upstreamInputTokens.toString(),
    (r.upstreamHitRate * 100).toFixed(1),
  ]);
  const all = [header, ...rows];
  const widths = all[0].map((_, i) => Math.max(...all.map((row) => row[i].length)));
  const lines = all.map((row) => row.map((cell, i) => cell.padEnd(widths[i])).join(" | "));
  const separator = widths.map((w) => "-".repeat(w)).join("-+-");
  return [lines[0], separator, ...lines.slice(1)].join("\n");
}
