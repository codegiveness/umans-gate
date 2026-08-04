import { describe, expect, it } from "bun:test";
import { parseModelInfoResponse } from "../../src/model-info-parser.js";
import {
  matchStampOverlay,
  resolveStampPolicy,
  STAMP_OVERLAY,
  type StampPolicy,
} from "../../src/stamp-catalog.js";

/** Minimal /v1/models/info body with the given model id as its sole key. */
function catalogWith(
  ...modelIds: string[]
): Map<string, ReturnType<typeof parseModelInfoResponse> extends Map<string, infer V> ? V : never> {
  const body: Record<string, unknown> = {};
  for (const id of modelIds) body[id] = { name: id };
  return parseModelInfoResponse(body);
}

describe("resolveStampPolicy", () => {
  it("resolves umans-glm* to the GLM policy (max effort, top_k=20, adaptive)", () => {
    const catalog = catalogWith("umans-glm-foo");
    expect(resolveStampPolicy("umans-glm-foo", catalog)).toEqual({
      max_tokens: 131071,
      effort: "max",
      thinking: true,
      top_k: 20,
      canDisableThinking: false,
      thinkingShape: { type: "adaptive" },
    });
  });

  it("resolves umans-coder to the high-effort thinking policy with adaptive shape", () => {
    const catalog = catalogWith("umans-coder");
    expect(resolveStampPolicy("umans-coder", catalog)).toEqual({
      max_tokens: 32767,
      effort: "high",
      thinking: true,
      top_k: null,
      canDisableThinking: false,
      thinkingShape: { type: "adaptive" },
    });
  });

  it("resolves umans-flash to the high-effort thinking policy with adaptive shape", () => {
    const catalog = catalogWith("umans-flash");
    expect(resolveStampPolicy("umans-flash", catalog)).toEqual({
      max_tokens: 32767,
      effort: "high",
      thinking: true,
      top_k: null,
      canDisableThinking: false,
      thinkingShape: { type: "adaptive" },
    });
  });

  it("resolves umans-kimi* to the high-effort thinking policy with adaptive shape", () => {
    const catalog = catalogWith("umans-kimi-bar");
    expect(resolveStampPolicy("umans-kimi-bar", catalog)).toEqual({
      max_tokens: 32767,
      effort: "high",
      thinking: true,
      top_k: null,
      canDisableThinking: false,
      thinkingShape: { type: "adaptive" },
    });
  });

  it("resolves umans-deepseek-v4-flash-0731 to the high-effort thinking policy with enabled shape", () => {
    const catalog = catalogWith("umans-deepseek-v4-flash-0731");
    expect(resolveStampPolicy("umans-deepseek-v4-flash-0731", catalog)).toEqual({
      max_tokens: 32767,
      effort: "high",
      thinking: true,
      top_k: null,
      canDisableThinking: false,
      thinkingShape: { type: "enabled" },
    });
  });

  it("resolves umans-qwen* to the high-effort thinking policy with adaptive shape", () => {
    const catalog = catalogWith("umans-qwen-baz");
    expect(resolveStampPolicy("umans-qwen-baz", catalog)).toEqual({
      max_tokens: 32767,
      effort: "high",
      thinking: true,
      top_k: null,
      canDisableThinking: false,
      thinkingShape: { type: "adaptive" },
    });
  });

  it("falls back to the * policy for an unknown model", () => {
    const catalog = catalogWith("umans-coder");
    const resolved = resolveStampPolicy("umans-legacy", catalog);
    expect(resolved).toEqual(STAMP_OVERLAY["*"]);
    expect(resolved.thinking).toBe(true);
    expect(resolved.top_k).toBeNull();
    expect(resolved.thinkingShape).toEqual({ type: "adaptive" });
  });

  it("falls back to the * policy for undefined model name", () => {
    const catalog = catalogWith("umans-coder");
    expect(resolveStampPolicy(undefined, catalog)).toEqual(STAMP_OVERLAY["*"]);
  });

  it("falls back to pattern match when the catalog is empty", () => {
    const catalog = catalogWith();
    expect(resolveStampPolicy("umans-glm-anything", catalog)).toEqual(STAMP_OVERLAY["umans-glm*"]);
  });
});

describe("matchStampOverlay", () => {
  const cases: Array<[string, StampPolicy]> = [
    ["umans-glm-foo", STAMP_OVERLAY["umans-glm*"]],
    ["umans-glm", STAMP_OVERLAY["umans-glm*"]],
    ["umans-coder", STAMP_OVERLAY["umans-coder"]],
    ["umans-flash", STAMP_OVERLAY["umans-flash"]],
    ["umans-deepseek-v4-flash-0731", STAMP_OVERLAY["umans-deepseek-v4-flash-0731"]],
    ["umans-kimi-x", STAMP_OVERLAY["umans-kimi*"]],
    ["umans-qwen-y", STAMP_OVERLAY["umans-qwen*"]],
    ["umans-legacy", STAMP_OVERLAY["*"]],
  ];

  for (const [model, expected] of cases) {
    it(`matches ${model}`, () => {
      expect(matchStampOverlay(model)).toBe(expected);
    });
  }

  it("does not treat umans-coder-extra as umans-coder (exact match required)", () => {
    expect(matchStampOverlay("umans-coder-extra")).toBe(STAMP_OVERLAY["*"]);
  });
});
